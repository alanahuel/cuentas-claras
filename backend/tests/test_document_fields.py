import pytest
from app.document_fields import money, parse_fields
from app.ocr import extract


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("1.234,56", 123456),
        ("1,234.56", 123456),
        ("1 234,56", 123456),
        ("0,01", 1),
        ("-15,00", -1500),
    ],
)
def test_money_formats(raw, expected):
    assert money(raw) == expected


def test_roles_dates_retention_and_total():
    text = """Factura nº F-2026/003
Vencimiento: 30/10/2026
Fecha de emisión: 3 de septiembre de 2026
Emisor: Servicios Álamo SL
CIF: B12345678
Cliente: María García
NIF: 12345678Z
Base imponible 1.000,00
IVA 21% 210,00
Retención IRPF 15% -150,00
Total factura 1.060,00"""
    expense = parse_fields(text)
    assert expense["fields"]["party"] == "Servicios Álamo SL"
    assert expense["fields"]["nif"] == "B12345678"
    assert expense["fields"]["date"] == "2026-09-03"
    assert expense["fields"]["number"] == "F-2026/003"
    assert expense["fields"]["withholding"] == 15000
    assert expense["reconciliation"]["matches"]
    income = parse_fields(text, "income")
    assert income["fields"]["party"] == "María García"
    assert income["fields"]["nif"] == "12345678Z"


def test_multiple_vat_table():
    result = parse_fields(
        "Base IVA Cuota\n100,00 21% 21,00\n50,00 10% 5,00\nTotal 176,00"
    )
    assert [(l["base"], l["vat_rate"]) for l in result["fields"]["lines"]] == [
        (10000, 21),
        (5000, 10),
    ]
    assert result["reconciliation"]["matches"]


def test_no_invented_fields_or_first_nif():
    result = parse_fields(
        "B12345678\n12345678Z\nFactura simplificada\nSubtotal 100,00\nTotal IVA 21,00\nTotal 121,00"
    )
    assert "nif" not in result["fields"]
    assert "number" not in result["fields"]
    assert result["fields"]["detected_total"] == 12100


@pytest.mark.parametrize(
    "text",
    [
        "Base imponible 100,00\nIVA 5% 5,00\nTotal 105,00",
        "Base imponible 100,00\nIVA 21% 25,00\nTotal 125,00",
        "Base imponible 100,00\nIVA 21%\nIVA 10%\nTotal 131,00",
        "Base imponible -100,00\nIVA 21% -21,00\nTotal -121,00",
        "Base imponible 100,00 USD\nIVA 21% 21,00\nTotal 121,00 USD",
    ],
)
def test_unsafe_amounts_not_applied(text):
    result = parse_fields(text)
    assert "lines" not in result["fields"]
    assert result["warnings"]


def test_ambiguous_values_and_due_dates():
    result = parse_fields(
        "Fecha 1/9/2026\nFecha 2/9/2026\nVencimiento 3/9/2026\nTotal 100,00\nTotal 200,00"
    )
    assert "date" not in result["fields"]
    assert "detected_total" not in result["fields"]
    assert len(result["warnings"]) == 2


def test_calculated_retention_and_mismatch():
    result = parse_fields("Base imponible 100,00\nIVA 21%\nIRPF 15%\nTotal 110,00")
    assert result["fields"]["withholding"] == 1500
    assert result["evidence"]["withholding"]["method"] == "calculated"
    assert result["reconciliation"]["difference"] == -400


def test_native_pdf_and_scanned_page(monkeypatch):
    import io

    import pymupdf
    from PIL import Image

    doc = pymupdf.open()
    doc.new_page().insert_text(
        (72, 72),
        "Factura F-123\nFecha 2026-09-03\nProveedor: Ejemplo SL\nNIF B12345678",
    )
    image = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(image, format="PNG")
    page = doc.new_page()
    page.insert_image(page.rect, stream=image.getvalue())
    monkeypatch.setattr(
        "app.ocr.read_image",
        lambda image: ("Base imponible 100,00\nIVA 21% 21,00\nTotal 121,00", ""),
    )
    result = extract(doc.tobytes())
    assert result["fields"]["number"] == "F-123"
    assert result["reconciliation"]["matches"]


def test_multiple_labeled_bases():
    result = parse_fields(
        "Base imponible 100,00\nIVA 21% 21,00\nBase imponible 50,00\nIVA 10% 5,00\nTotal: EUR 176,00"
    )
    assert len(result["fields"]["lines"]) == 2
    assert result["reconciliation"]["matches"]


def test_split_due_date_not_used_as_invoice_date():
    assert "date" not in parse_fields("Vencimiento:\n03/09/2026")["fields"]
    assert (
        parse_fields("Fecha:\n01/09/2026\nVencimiento:\n03/09/2026")["fields"]["date"]
        == "2026-09-01"
    )


def test_invalid_table_row_prevents_partial_breakdown():
    result = parse_fields("100,00 21% 21,00\n200,00 21% 50,00\nTotal 371,00")
    assert "lines" not in result["fields"]


def test_multiple_invoices_are_not_combined():
    result = parse_fields(
        "Factura F-001\nProveedor: Uno\nNIF B12345678\nTotal 121,00\nFactura F-002\nProveedor: Dos\nNIF B87654321\nTotal 242,00"
    )
    assert result["fields"] == {}
    assert result["parties"] == {"income": {}, "expense": {}}
    assert any("por separado" in warning for warning in result["warnings"])


def test_conflicting_party_ids_are_left_for_review():
    result = parse_fields("Proveedor: Ejemplo SL\nNIF B12345678\nNIF B87654321")
    assert "nif" not in result["fields"]
    assert "nif" not in result["parties"]["expense"]


def test_tesseract_discovery_timeout_is_recoverable(monkeypatch):
    import subprocess

    from app.ocr import read_image
    from PIL import Image

    monkeypatch.setattr("app.ocr.shutil.which", lambda command: "/synthetic/tesseract")

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("tesseract", 10)

    monkeypatch.setattr("app.ocr.subprocess.run", timeout)
    text, warning = read_image(Image.new("RGB", (10, 10)))
    assert text == ""
    assert "tardó demasiado" in warning
