"""Isolated browser fixture: never calls an external provider."""
import os
import sys
from pathlib import Path

if not os.environ.get('DATA_DIR', '').endswith('cuentas-e2e'):
    raise SystemExit('Use an isolated DATA_DIR ending in cuentas-e2e.')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import document_ai

document_ai.configuration = lambda: {'available': True, 'provider': 'Test fixture'}
document_ai.analyze = lambda *args: {
    'classification': {'document_type': 'invoice', 'issuer_country': 'ES'},
    'fields': {'date': '2026-09-30', 'lines': [{'base': 10000, 'vat_rate': 21}], 'withholding': 0, 'detected_total': 12100},
    'parties': {'income': {'party': 'Example', 'nif': 'B12345678'}, 'expense': {'party': 'Example', 'nif': 'B12345678'}},
    'warnings': [], 'extraction_version': 2,
}
import uvicorn
uvicorn.run('app.main:app', host='127.0.0.1', port=8018)
