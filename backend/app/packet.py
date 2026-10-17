"""Quarter handoff: printable record sheets plus unmodified originals in ZIP."""

import csv
import io
import json
import textwrap
import zipfile
from pathlib import Path
import pymupdf
from PIL import Image, ImageOps


def build_packet(folder, rows, documents, user, year, quarter, totals):
    folder = Path(folder)
    pdf_path = folder / "trimestre.pdf"
    zip_path = folder / "trimestre.zip"
    pdf = pymupdf.open()
    font_path = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    page = None
    y = 0

    def line(text="", size=10):
        nonlocal page, y
        for paragraph in str(text).split("\n"):
            for part in textwrap.wrap(
                paragraph, width=88 if size == 10 else 65, replace_whitespace=True
            ) or [""]:
                if page is None or y > 790:
                    page = pdf.new_page(width=595, height=842)
                    if font_path.exists():
                        page.insert_font(fontname="body", fontfile=str(font_path))
                    y = 42
                page.insert_text(
                    (36, y),
                    part,
                    fontsize=size,
                    fontname="body" if font_path.exists() else "helv",
                )
                y += size + 6

    def amount(value):
        return f"{value / 100:.2f} EUR"

    line(f"Cuentas - {year} / T{quarter}", 16)
    line(f"Titular: {user['name']} ({user['email']})")
    line(
        "Dossier de apoyo para tu gestor. No es una declaración ni una factura emitida."
    )
    line(f"{len(rows)} registros. Incluye borradores, identificados como POR REVISAR.")
    line(
        "Las estimaciones solo incluyen registros revisados. Los originales siguen a cada ficha."
    )
    for kind, title in [
        ("income", "Ingresos revisados"),
        ("expense", "Gastos revisados"),
    ]:
        selected = [r for r in rows if r["kind"] == kind and r["status"] == "confirmed"]
        line(
            f"{title}: base {amount(sum(r['base'] for r in selected))}; IVA {amount(sum(r['vat'] for r in selected))}"
        )
    for key, label in [
        ("vat_reserve", "Reserva IVA"),
        ("irpf_reserve", "Reserva IRPF"),
        ("tax_reserve", "Reserva total"),
        ("saved_amount", "Apartado"),
    ]:
        value = totals.get(key)
        line(
            f"{label}: {amount(value) if value is not None else 'Pendiente de configurar/revisar'}"
        )
    line("Los archivos pendientes de asociar no tienen trimestre y no están incluidos.")
    line("Índice de registros", 13)
    for i, row in enumerate(rows, 1):
        line(
            f"{i:04d} | {row['date']} | {row['number'] or 'Sin número'} | {row['party']} | {'Revisado' if row['status'] == 'confirmed' else 'POR REVISAR'}"
        )
    attachments = []
    for i, row in enumerate(rows, 1):
        page = None
        line(
            f"Registro {i:04d} - {'Gasto' if row['kind'] == 'expense' else 'Ingreso'}",
            16,
        )
        for key, label in [
            ("status", "Estado"),
            ("date", "Fecha"),
            ("number", "Número"),
            ("party", "Tercero"),
            ("nif", "NIF"),
            ("category", "Categoría"),
        ]:
            value = row[key]
            if key == "status":
                value = (
                    "Revisado"
                    if value == "confirmed"
                    else "POR REVISAR - excluido de estimaciones"
                )
            line(f"{label}: {value}")
        for entry in row["lines"]:
            line(f"Concepto: {entry['description'] or 'Sin descripción'}")
            line(
                f"Base {amount(entry['base'])}; IVA {entry['vat_rate']}%; deducible IVA {entry['vat_deduct']}%; deducible IRPF {entry['irpf_deduct']}%"
            )
        for key, label in [
            ("base", "Base"),
            ("vat", "IVA"),
            ("withholding", "Retención"),
            ("total", "Total"),
            ("deductible_base", "Base deducible IRPF"),
            ("deductible_vat", "IVA deducible"),
        ]:
            line(f"{label}: {amount(row[key])}")
        line(f"Notas: {row['note'] or 'Sin notas'}")
        document = documents.get(row["document_id"])
        if not document:
            line("SIN JUSTIFICANTE ADJUNTO. Esta ficha no sustituye al original.")
            continue
        path = Path(document["path"])
        line(f"Original: {document['name']} (a continuación)")
        suffix = {
            "application/pdf": ".pdf",
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
        }[document["mime"]]
        attachments.append((path, f"originales/{i:04d}-{row['kind']}{suffix}"))
        if document["mime"] == "application/pdf":
            with pymupdf.open(path) as source:
                if source.needs_pass:
                    raise ValueError("Un original está protegido con contraseña.")
                pdf.insert_pdf(source, links=False, annots=True, widgets=True)
        else:
            with Image.open(path) as image:
                corrected = ImageOps.exif_transpose(image).convert("RGB")
                buffer = io.BytesIO()
                corrected.save(buffer, format="JPEG", quality=95)
                photo = pdf.new_page(width=595, height=842)
                photo.insert_image(
                    pymupdf.Rect(20, 20, 575, 822), stream=buffer.getvalue()
                )
    pdf.save(pdf_path, garbage=3, deflate=True)
    pdf.close()
    out = io.StringIO()
    fields = [
        "date",
        "kind",
        "status",
        "number",
        "party",
        "nif",
        "category",
        "base",
        "vat",
        "withholding",
        "total",
        "deductible_base",
        "deductible_vat",
        "note",
        "document_id",
    ]
    writer = csv.writer(out, delimiter=";")
    writer.writerow(fields)
    for row in rows:
        values = []
        for key in fields:
            value = row[key]
            if key in (
                "base",
                "vat",
                "withholding",
                "total",
                "deductible_base",
                "deductible_vat",
            ):
                value = f"{value / 100:.2f}".replace(".", ",")
            value = str(value or "")
            values.append(
                "'" + value
                if value.lstrip().startswith(("=", "+", "-", "@"))
                else value
            )
        writer.writerow(values)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(pdf_path, "imprimir-trimestre.pdf")
        archive.writestr("registro.csv", "\ufeff" + out.getvalue())
        archive.writestr(
            "datos-completos.json",
            json.dumps(
                {
                    "year": year,
                    "quarter": quarter,
                    "profile": json.loads(user["profile"]),
                    "summary": totals,
                    "records": rows,
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
        archive.writestr(
            "LEEME.txt",
            "Imprime imprimir-trimestre.pdf: incluye fichas y originales.\nOriginales sin modificar en originales/. CSV: importes en euros; JSON: importes en céntimos.\nBorradores marcados POR REVISAR; registros sin archivo marcados SIN JUSTIFICANTE.\nDocumentos sin asociar y borradores sin sincronizar no están incluidos.\n",
        )
        for path, name in attachments:
            archive.write(path, name)
    return pdf_path, zip_path
