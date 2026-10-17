import pytest
from test_app import env, client, invoice
from test_invoice_checks import setup_check


@pytest.mark.parametrize('kind', ['income', 'expense'])
def test_delete_confirmed_recalculates_and_preserves_original(env, monkeypatch, kind):
    c, item, reading, calls = setup_check(env, monkeypatch)
    with env.db() as con:
        con.execute('UPDATE invoices SET kind=? WHERE id=?', (kind, item['id']))
    c.post(f'/api/invoices/{item["id"]}/check')
    route = f'/api/invoices/{item["id"]}'
    assert client(env, 'bob').delete(route+'?version=1').status_code == 404
    assert c.delete(route+'?version=2').status_code == 409
    assert c.delete(route).status_code == 409
    assert c.delete(route+'?version=1').status_code == 200
    assert c.get('/api/invoices').json() == []
    summary = c.get('/api/summary?year=2026&quarter=4').json()
    assert summary['count'] == 0 and summary['vat_balance'] == 0
    assert c.get('/api/documents/original').status_code == 200
    assert c.get('/api/documents').json()[0]['id'] == 'original'
    assert c.get('/api/invoice-checks').json() == []
    with env.db() as con:
        assert con.execute("SELECT 1 FROM audit WHERE action='invoice.delete' AND entity=?", (item['id'],)).fetchone()


def test_delete_confirmed_requires_agency_authority(env):
    c = client(env)
    item = c.post('/api/invoices', json=invoice()).json()
    with env.db() as con:
        con.execute("INSERT INTO agencies(user_id,name,enabled) VALUES('bob','Agency',1)")
        con.execute("INSERT INTO client_access(manager_id,client_id,managed,archived) VALUES('bob','alice',0,0)")
    route = f'/api/invoices/{item["id"]}?version=1'
    assert c.delete(route).status_code == 403
    manager = client(env, 'bob')
    manager.headers['X-Workspace-Id'] = 'alice'
    assert manager.delete(route).status_code == 200
