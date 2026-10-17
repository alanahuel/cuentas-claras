import io
import json
from urllib.error import URLError

import pytest
from app import document_ai as ai


def reading(**changes):
    data = {
        "document_type": "invoice", "issuer_country": "ES", "classification_evidence": "Emisor en Madrid, España.",
        "invoice_date": "2026-09-03",
        "number": "AI-123",
        "supplier": {"name": "Proveedor", "nif": "B12345678"},
        "customer": {"name": "Cliente", "nif": "12345678Z"},
        "currency": "EUR",
        "lines": [
            {
                "base": 10000,
                "vat_rate": 21,
                "vat_amount": 2100,
                "description": "Servicios",
            }
        ],
        "withholding": 1500,
        "total": 10600,
        "warnings": [],
    }
    return ai.Reading(**(data | changes))


def test_ai_roles_and_arithmetic(monkeypatch):
    monkeypatch.setattr(ai, "request_reading", lambda *args: reading())
    result = ai.analyze(b"pdf", "application/pdf", "income")
    assert result["fields"]["party"] == "Cliente"
    assert result["fields"]["withholding"] == 1500
    assert result["reconciliation"]["matches"]
    assert result["review_required"]
    assert "status" not in result["fields"]


@pytest.mark.parametrize(
    "changes",
    [
        {"currency": "USD"},
        {"currency": None},
        {"total": -10600},
        {
            "lines": [
                {"base": 10000, "vat_rate": 5, "vat_amount": 500, "description": ""}
            ]
        },
        {
            "lines": [
                {"base": 10000, "vat_rate": 21, "vat_amount": 2300, "description": ""}
            ]
        },
    ],
)
def test_ai_unsafe_amounts(monkeypatch, changes):
    monkeypatch.setattr(ai, "request_reading", lambda *args: reading(**changes))
    result = ai.analyze(b"pdf", "application/pdf", "expense")
    assert "lines" not in result["fields"]
    assert result["warnings"]


def test_ai_invalid_date_and_total_mismatch(monkeypatch):
    monkeypatch.setattr(
        ai,
        "request_reading",
        lambda *args: reading(invoice_date="2026-02-30", total=15000),
    )
    result = ai.analyze(b"pdf", "application/pdf", "expense")
    assert "date" not in result["fields"]
    assert result["reconciliation"]["difference"] == -4400


@pytest.mark.parametrize(
    "mime,attachment_type",
    [("application/pdf", "input_file"), ("image/jpeg", "input_image")],
)
def test_provider_payload_and_strict_response(monkeypatch, mime, attachment_type):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("DOCUMENT_AI_MODEL", "test-vision-model")

    def request(req, timeout):
        payload = json.loads(req.data)
        assert req.full_url == "https://api.openai.com/v1/responses"
        assert payload["store"] is False
        assert payload["model"] == "test-vision-model"
        assert payload["text"]["format"]["strict"] is True
        assert payload["input"][0]["content"][1]["type"] == attachment_type
        assert timeout == 60
        return io.BytesIO(
            json.dumps(
                {
                    "status": "completed",
                    "output": [
                        {
                            "type": "message",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": reading().model_dump_json(),
                                }
                            ],
                        }
                    ],
                }
            ).encode()
        )

    monkeypatch.setattr(ai, "urlopen", request)
    assert ai.request_reading(b"fixture", mime).total == 10600


@pytest.mark.parametrize(
    "response",
    [
        {"status": "incomplete", "output": []},
        {
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "refusal", "refusal": "No"}]}
            ],
        },
        {
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "{}"}]}
            ],
        },
        {"status": "completed", "output": None},
    ],
)
def test_incomplete_refusal_and_malformed(monkeypatch, response):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("DOCUMENT_AI_MODEL", "test-model")
    monkeypatch.setattr(
        ai, "urlopen", lambda *args, **kwargs: io.BytesIO(json.dumps(response).encode())
    )
    with pytest.raises(ai.AIUnavailable):
        ai.request_reading(b"fixture", "application/pdf")


def test_missing_config_and_network_failure(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ai.AIUnavailable, match="no está configurada"):
        ai.request_reading(b"fixture", "application/pdf")
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("DOCUMENT_AI_MODEL", "test-model")

    def fail(*args, **kwargs):
        raise URLError("secret-provider-debug")

    monkeypatch.setattr(ai, "urlopen", fail)
    with pytest.raises(ai.AIUnavailable) as error:
        ai.request_reading(b"fixture", "application/pdf")
    assert "secret-provider-debug" not in str(error.value)

@pytest.mark.parametrize('country', ['US','IE',None])
def test_foreign_or_unknown_country_copies_visible_amounts(monkeypatch, country):
    monkeypatch.setattr(ai,'request_reading',lambda *args:reading(issuer_country=country))
    result=ai.analyze(b'pdf','application/pdf','expense')
    assert result['classification']['issuer_country']==country
    assert result['classification']['is_spanish'] is (None if country is None else False)
    assert result['fields']['party']=='Proveedor'
    assert result['fields']['number']=='AI-123'
    assert result['fields']['lines'][0]['base']==10000
    assert result['fields']['lines'][0]['vat_rate']==21
    assert 'withholding' not in result['fields']
    assert result['warnings']

@pytest.mark.parametrize('kind',['other','unknown'])
def test_non_documents_never_autofill(monkeypatch,kind):
    monkeypatch.setattr(ai,'request_reading',lambda *args:reading(document_type=kind))
    result=ai.analyze(b'pdf','application/pdf','expense')
    assert result['fields']=={}
    assert result['parties']=={'expense':{},'income':{}}
    assert result['classification']['document_type']==kind

def test_spanish_receipt_classification(monkeypatch):
    monkeypatch.setattr(ai,'request_reading',lambda *args:reading(document_type='receipt'))
    result=ai.analyze(b'pdf','application/pdf','expense')
    assert result['classification']['document_type']=='receipt'
    assert result['classification']['is_spanish'] is True
    assert result['fields']['lines'][0]['base']==10000
    assert result['warnings']


def test_irish_invoice_visible_base_and_vat(monkeypatch):
    monkeypatch.setattr(ai, 'request_reading', lambda *args: reading(
        issuer_country='IE', withholding=0, total=8468,
        lines=[{'base':6998,'vat_rate':21,'vat_amount':1470,'description':'Suscripción'}]))
    result=ai.analyze(b'pdf','application/pdf','expense')
    assert result['fields']['lines'][0]['base']==6998
    assert result['fields']['lines'][0]['vat_rate']==21
    assert result['reconciliation']=={'calculated_total':8468,'difference':0,'matches':True}
    assert result['extraction_version']==2
