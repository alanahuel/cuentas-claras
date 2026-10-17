import hashlib
import json
import pytest
from app import document_ai
from app.invoice_check import compare
from test_app import env, client, invoice  # noqa: F401


def setup_check(env, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'synthetic-key')
    monkeypatch.setenv('DOCUMENT_AI_MODEL', 'test-model')
    content = b'synthetic document for mocked vision'
    path = env.DATA / 'original.pdf'
    path.write_bytes(content)
    with env.db() as con:
        con.execute('INSERT INTO documents VALUES(?,?,?,?,?,?)', ('original', 'alice', 'original.pdf', 'application/pdf', hashlib.sha256(content).hexdigest(), str(path)))
    reading = {'classification': {'document_type': 'invoice'}, 'fields': {'date': '2026-09-30', 'number': '2026-01', 'withholding': 15000, 'detected_total': 106000, 'lines': [{'base': 100000, 'vat_rate': 21}]}, 'parties': {'income': {'party': 'Cliente', 'nif': 'B12345678'}, 'expense': {'party': 'Proveedor', 'nif': 'B87654321'}}, 'warnings': []}
    calls = []
    def analyze(*args):
        calls.append(args)
        return reading
    monkeypatch.setattr(document_ai, 'analyze', analyze)
    c = client(env)
    payload = {**invoice(), 'date': '2026-10-01', 'document_id': 'original'}
    response = c.post('/api/invoices', json=payload)
    assert response.status_code == 200, response.text
    return c, response.json(), reading, calls


def test_independent_reading_persistence_isolation_and_no_invoice_changes(env, monkeypatch):
    c, item, reading, calls = setup_check(env, monkeypatch)
    before = c.get('/api/invoices').json()
    with env.db() as con:
        con.execute("INSERT INTO document_analyses VALUES('original','completed',?,0,'old')", (json.dumps({'fields': {'date': '2026-10-01'}}),))
    checked = c.post(f'/api/invoices/{item["id"]}/check')
    assert checked.status_code == 200, checked.text
    data = checked.json()
    assert data['status'] == 'differences'
    assert data['period_change'] == {'recorded': 'T4 2026', 'detected': 'T3 2026'}
    assert [d['field'] for d in data['differences']] == ['date']
    assert len(calls) == 1
    assert c.get('/api/invoices').json() == before
    assert c.get('/api/invoice-checks').json()[0]['period_change'] == data['period_change']
    assert c.post(f'/api/invoices/{item["id"]}/check').json()['reused']
    assert len(calls) == 1
    assert not c.post(f'/api/invoices/{item["id"]}/check?reread=true').json()['reused']
    assert len(calls) == 2
    bob = client(env, 'bob')
    assert bob.get('/api/invoice-checks').json() == []
    assert bob.post(f'/api/invoices/{item["id"]}/check').status_code == 404
    with env.db() as con:
        con.execute('DELETE FROM invoices WHERE id=?', (item['id'],))
        assert con.execute('SELECT count(*) FROM invoice_checks').fetchone()[0] == 0


def test_modified_record_recompared_and_stale_during_read(env, monkeypatch):
    c, item, reading, calls = setup_check(env, monkeypatch)
    route = f'/api/invoices/{item["id"]}/check'
    def concurrent_change(*args):
        with env.db() as con:
            con.execute("UPDATE invoices SET date='2026-09-30',version=version+1 WHERE id=?", (item['id'],))
        return reading
    monkeypatch.setattr(document_ai, 'analyze', concurrent_change)
    assert c.post(route).json()['status'] == 'outdated'
    assert c.get('/api/invoice-checks').json()[0]['status'] == 'outdated'
    assert c.post(route).json()['status'] == 'matched'
    assert c.get('/api/invoice-checks').json()[0]['status'] == 'matched'


def test_missing_original_and_unavailable_reader(env, monkeypatch):
    c, item, reading, calls = setup_check(env, monkeypatch)
    monkeypatch.delenv('OPENAI_API_KEY')
    assert c.post(f'/api/invoices/{item["id"]}/check').status_code == 503
    no_doc = c.post('/api/invoices', json={**invoice(), 'number': 'NO-DOC'}).json()
    assert c.post(f'/api/invoices/{no_doc["id"]}/check').json()['status'] == 'no_document'
    assert len(calls) == 0


def test_integrity_failure_and_limit(env, monkeypatch):
    c, item, reading, calls = setup_check(env, monkeypatch)
    route = f'/api/invoices/{item["id"]}/check'
    (env.DATA / 'original.pdf').write_bytes(b'changed')
    assert c.post(route).status_code == 422
    with env.db() as con:
        con.execute("INSERT INTO attempts VALUES('invoice-check:alice',100,9999999999)")
    assert c.post(route).status_code == 429
    assert not calls


def test_provider_failure_retry_pending_and_deleted_during_read(env, monkeypatch):
    c, item, reading, calls = setup_check(env, monkeypatch)
    route = f'/api/invoices/{item["id"]}/check'
    def failed(*args):
        raise document_ai.AIUnavailable('Lectura fallida')
    monkeypatch.setattr(document_ai, 'analyze', failed)
    assert c.post(route).status_code == 502
    def deleted(*args):
        assert c.post(route).status_code == 409
        with env.db() as con:
            con.execute('DELETE FROM invoices WHERE id=?', (item['id'],))
        return reading
    monkeypatch.setattr(document_ai, 'analyze', deleted)
    assert c.post(route).status_code == 404
    with env.db() as con:
        assert con.execute('SELECT count(*) FROM invoice_checks').fetchone()[0] == 0


def test_comparison_missing_fields_roles_and_tax_breakdown():
    item = dict(kind='expense', date='2026-09-30', number='A-1', party='Proveedor', nif='B12345678', total=12100, withholding=0, lines=[dict(base=5000, vat_rate=21), dict(base=5000, vat_rate=21)])
    read = dict(classification={'document_type': 'invoice'}, fields=dict(date='2026-09-30', number='A-1', detected_total=12100, withholding=0, lines=[dict(base=10000, vat_rate=21)]), parties={'expense': {'party': 'PROVEEDOR', 'nif': 'B-12345678'}}, warnings=[])
    assert compare(item, read)['status'] == 'matched'
    del read['fields']['withholding']
    assert compare(item, read)['status'] == 'incomplete'
    read['fields']['lines'] = [dict(base=11000, vat_rate=10)]
    differences = compare(item, read)['differences']
    assert differences[0]['field'] == 'lines'
    read['classification']['document_type'] = 'other'
    result = compare(item, read)
    assert result['status'] == 'incomplete' and len(result['missing']) == 7


def test_apply_correction_updates_period_and_preserves_record(env, monkeypatch):
    c, item, reading, calls = setup_check(env, monkeypatch)
    check = c.post(f'/api/invoices/{item["id"]}/check').json()
    assert check['correctable_fields'] == ['date']
    before = c.get('/api/summary?year=2026&quarter=3').json()['output_vat']
    response = c.post(f'/api/invoices/{item["id"]}/apply-check', json={'version': item['version'], 'check_id': check['check_id']})
    assert response.status_code == 200, response.text
    saved = response.json()['invoice']
    assert saved['date'] == '2026-09-30' and saved['version'] == 2
    assert saved['status'] == item['status'] and saved['lines'] == item['lines']
    assert c.get('/api/summary?year=2026&quarter=3').json()['output_vat'] == before + 21000
    assert c.get('/api/invoice-checks').json()[0]['status'] == 'matched'
    assert len(calls) == 1
    assert c.post(f'/api/invoices/{item["id"]}/apply-check', json={'version': 1, 'check_id': check['check_id']}).status_code == 409
    history = c.get(f'/api/invoices/{item["id"]}/reviews').json()
    assert history[0]['action'] == 'corrected_from_original'
    assert '2026-10-01' in history[0]['comment']


def test_apply_rejects_new_reading_other_account_and_duplicate(env, monkeypatch):
    c, item, reading, calls = setup_check(env, monkeypatch)
    check = c.post(f'/api/invoices/{item["id"]}/check').json()
    body = {'version': 1, 'check_id': check['check_id']}
    route = f'/api/invoices/{item["id"]}/apply-check'
    assert client(env, 'bob').post(route, json=body).status_code == 404
    c.post(f'/api/invoices/{item["id"]}/check?reread=true')
    assert c.post(route, json=body).status_code == 409
    reading['fields']['number'] = 'DUPLICATE'
    c.post('/api/invoices', json={**invoice(), 'number': 'DUPLICATE'})
    check = c.post(f'/api/invoices/{item["id"]}/check?reread=true').json()
    assert c.post(route, json={**body, 'check_id': check['check_id']}).status_code == 409
    assert next(i for i in c.get('/api/invoices').json() if i['id'] == item['id'])['date'] == '2026-10-01'


def test_correction_preserves_deductions_and_blocks_inconsistent_money():
    from app.invoice_check import correction_plan
    item = dict(kind='expense', date='2026-10-01', number='A', party='Supplier', nif='B1', total=12100, withholding=0, lines=[dict(base=10000, vat_rate=21, irpf_deduct=50, vat_deduct=25, description='Manual')])
    reading = dict(classification={'document_type': 'invoice'}, fields=dict(date='2026-09-30', lines=[dict(base=20000, vat_rate=21)], detected_total=24200), parties={})
    result = compare(item, reading)
    patch, notes = correction_plan(item, reading, result['differences'])
    assert patch['lines'][0] == dict(base=20000, vat_rate=21, irpf_deduct=50, vat_deduct=25, description='Manual')
    assert not notes
    reading['fields']['detected_total'] = 99999
    result = compare(item, reading)
    patch, notes = correction_plan(item, reading, result['differences'])
    assert patch == {'date': '2026-09-30'} and notes


def test_correction_respects_agency_approval(env, monkeypatch):
    c, item, reading, calls = setup_check(env, monkeypatch)
    check = c.post(f'/api/invoices/{item["id"]}/check').json()
    with env.db() as con:
        con.execute("INSERT INTO agencies(user_id,name,enabled) VALUES('bob','Agency',1)")
        con.execute("INSERT INTO client_access(manager_id,client_id,managed,archived) VALUES('bob','alice',0,0)")
    response = c.post(f'/api/invoices/{item["id"]}/apply-check', json={'version': 1, 'check_id': check['check_id']})
    assert response.status_code == 403
    assert c.get('/api/invoices').json()[0]['version'] == 1
