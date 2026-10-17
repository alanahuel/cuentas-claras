import hashlib
import json
from fastapi.testclient import TestClient
from test_app import env, client, invoice  # noqa: F401


def create_share(c, **kwargs):
    r = c.post('/api/reports/shares', json={'year': 2026, 'quarter': 1, 'hours': 1, **kwargs})
    assert r.status_code == 201, r.text
    return r.json()


def test_report_snapshot_scope_and_revocation(env):
    alice, bob = client(env), client(env, 'bob')
    r = alice.post('/api/invoices', json=invoice(note='<script>alert(1)</script>'))
    assert r.status_code == 200, r.text
    share = create_share(alice)
    public = TestClient(env.app)
    response = public.get(share['url'])
    assert response.status_code == 200
    assert '1.000,00 €' in response.text
    assert '&lt;script&gt;alert(1)&lt;/script&gt;' in response.text
    assert '<script>alert(1)</script>' not in response.text
    assert 'noindex' in response.headers['X-Robots-Tag']
    assert response.headers['Cache-Control'] == 'no-store'
    assert response.headers['Referrer-Policy'] == 'no-referrer'
    with env.db() as con:
        con.execute("UPDATE invoices SET base=200000 WHERE user_id='alice'")
        stored = con.execute('SELECT * FROM report_shares').fetchone()
        assert share['url'].split('/')[-1] not in stored['snapshot']
        assert stored['token_hash'] == hashlib.sha256(share['url'].split('/')[-1].encode()).hexdigest()
    assert '1.000,00 €' in public.get(share['url']).text
    assert '2.000,00 €' not in public.get(share['url']).text
    assert bob.get('/api/reports/shares?year=2026&quarter=1').json() == []
    assert bob.delete('/api/reports/shares/' + share['id']).status_code == 404
    assert bob.get('/api/reports/preview?year=2026&quarter=1&workspace=alice').status_code == 403
    assert alice.delete('/api/reports/shares/' + share['id']).status_code == 200
    assert public.get(share['url']).status_code == 404
    assert public.get(share['url'] + '/status').status_code == 404


def test_expiry_documents_and_account_cascade(env, tmp_path):
    alice = client(env)
    with env.db() as con:
        for did, owner in [('included', 'alice'), ('outside', 'alice'), ('foreign', 'bob')]:
            path = tmp_path / (did + '.pdf')
            path.write_bytes(b'%PDF-test-' + did.encode())
            con.execute('INSERT INTO documents VALUES(?,?,?,?,?,?)',
                        (did, owner, did + '.pdf', 'application/pdf', did, str(path)))
    assert alice.post('/api/invoices', json=invoice(document_id='included')).status_code == 200
    share = create_share(alice)
    public = TestClient(env.app)
    assert public.get(share['url'] + '/documents/included').status_code == 200
    for did in ['outside', 'foreign']:
        assert public.get(share['url'] + '/documents/' + did).status_code == 404
    with env.db() as con:
        con.execute('UPDATE report_shares SET expires=0 WHERE id=?', (share['id'],))
    for suffix in ['', '/status', '/documents/included']:
        response = public.get(share['url'] + suffix)
        assert response.status_code == 404
        assert 'noindex' in response.headers['x-robots-tag']
        assert response.headers['cache-control'] == 'no-store'
    assert alice.get('/api/reports/shares?year=2026&quarter=1').json() == []
    second = create_share(alice)
    # The FK deletes snapshots together with their owner, including managed accounts.
    with env.db() as con:
        con.execute("DELETE FROM invoices WHERE user_id='alice'")
        con.execute("DELETE FROM documents WHERE user_id='alice'")
        con.execute("DELETE FROM sessions WHERE user_id='alice'")
        con.execute("DELETE FROM users WHERE id='alice'")
    assert public.get(second['url']).status_code == 404


def test_periods_drafts_and_validation(env):
    alice = client(env)
    for values in [dict(date='2026-01-10', number='JAN', base=100000),
                   dict(date='2026-04-10', number='APR', base=200000),
                   dict(date='2026-04-11', number='DRAFT', base=900000, status='draft'),
                   dict(date='2026-07-10', number='JUL', base=700000)]:
        payload = invoice()
        base = values.pop('base')
        payload.update(values)
        payload['lines'] = [{'base': base, 'vat_rate': 21}]
        assert alice.post('/api/invoices', json=payload).status_code == 200
    share = create_share(alice, quarter=2)
    with env.db() as con:
        data = json.loads(con.execute('SELECT snapshot FROM report_shares WHERE id=?', (share['id'],)).fetchone()[0])
    assert data['summary']['income'] == 300000
    assert data['summary']['quarter_income'] == 200000
    assert len(data['records']) == 3
    page = TestClient(env.app).get(share['url']).text
    assert 'Anexo · registros anteriores del año' in page
    assert '1 registros del trimestre pendientes' in page
    assert 'JUL' not in page
    assert 'Pendiente de configurar' in page
    for values in [{'hours': 0}, {'hours': 721}, {'quarter': 5}, {'year': 1900}]:
        assert alice.post('/api/reports/shares', json={'year': 2026, 'quarter': 1, **values}).status_code == 422
    assert TestClient(env.app).post('/api/reports/shares', json={'year': 2026, 'quarter': 1}).status_code == 401
    assert alice.get('/api/reports/preview?year=2026&quarter=4').status_code == 200
    # CSRF remains mandatory for creation and revocation.
    alice.headers.pop('X-CSRF-Token')
    assert alice.post('/api/reports/shares', json={'year': 2026, 'quarter': 1}).status_code == 403
    assert alice.delete('/api/reports/shares/' + share['id']).status_code == 403
