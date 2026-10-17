from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import threading
import pymupdf
from app import document_ai
from test_app import env, client, invoice


def pdf(label='SYNTHETIC-001'):
    doc=pymupdf.open();doc.new_page().insert_text((72,72),'Factura '+label+'\nProveedor: Ejemplo SL\nNIF B12345678\nMadrid, Espana')
    return doc.tobytes()


def configure(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY','never-sent-test-key')
    monkeypatch.setenv('DOCUMENT_AI_MODEL','test-model')
    calls=[]
    def analyze(content,mime,kind):
        calls.append(kind)
        return {'fields':{'number':'AUTO-123','party':'Proveedor IA'}, 'parties':{'expense':{'party':'Proveedor IA'},'income':{'party':'Cliente IA'}},
                'classification':{'document_type':'invoice','issuer_country':'ES','is_spanish':True,'evidence':'Emisor en Madrid'},
                'engine':'OpenAI · lectura con IA','warnings':[]}
    monkeypatch.setattr(document_ai,'analyze',analyze)
    return calls


def test_automatic_upload_cached_reopen_and_private_delete(env,monkeypatch):
    calls=configure(monkeypatch);a,b=client(env),client(env,'bob')
    r=a.post('/api/documents',files={'file':('ejemplo.pdf',pdf(),'application/pdf')})
    assert r.status_code==200
    data=r.json();did=data['id'];assert data['fields']['number']=='AUTO-123'
    assert data['classification']['is_spanish'] and calls==['expense']
    r=a.post(f'/api/documents/{did}/prepare?kind=income')
    assert r.json()['cached'] and r.json()['fields']['party']=='Cliente IA'
    assert calls==['expense']
    assert b.post(f'/api/documents/{did}/prepare').status_code==404
    assert b.delete(f'/api/documents/{did}').status_code==404
    with env.db() as con:
        path=Path(con.execute('SELECT path FROM documents WHERE id=?',(did,)).fetchone()[0])
    assert a.delete(f'/api/documents/{did}').json()=={'ok':True,'file_pending':False}
    assert not path.exists()
    assert a.get(f'/api/documents/{did}').status_code==404
    assert a.get('/api/documents').json()==[]
    with env.db() as con:
        assert con.execute('SELECT COUNT(*) FROM document_analyses').fetchone()[0]==0


def test_attached_documents_cannot_be_deleted(env,monkeypatch):
    configure(monkeypatch);a=client(env)
    did=a.post('/api/documents',files={'file':('ejemplo.pdf',pdf(),'application/pdf')}).json()['id']
    assert a.post('/api/invoices',json=invoice(document_id=did)).status_code==200
    assert a.delete(f'/api/documents/{did}').status_code==409
    assert a.get(f'/api/documents/{did}').status_code==200


def test_failure_preserves_file_and_local_reading(env,monkeypatch):
    configure(monkeypatch)
    def fail(*args):raise document_ai.AIUnavailable('Fallo de prueba')
    monkeypatch.setattr(document_ai,'analyze',fail)
    a=client(env)
    r=a.post('/api/documents',files={'file':('ejemplo.pdf',pdf(),'application/pdf')})
    assert r.status_code==200 and r.json()['ai_error']=='Fallo de prueba'
    assert r.json()['id'] and r.json()['warnings']
    calls=configure(monkeypatch)
    r=a.post('/api/documents/'+r.json()['id']+'/prepare')
    assert r.json()['fields']['number']=='AUTO-123' and len(calls)==1


def test_simultaneous_analysis_and_delete_does_not_restore_document(env,monkeypatch):
    monkeypatch.delenv('DOCUMENT_AI_MODEL',raising=False)
    a=client(env);did=a.post('/api/documents',files={'file':('ejemplo.pdf',pdf(),'application/pdf')}).json()['id']
    configure(monkeypatch);started,release=threading.Event(),threading.Event()
    def slow(*args):
        started.set();release.wait(5);return {'fields':{},'parties':{}}
    monkeypatch.setattr(document_ai,'analyze',slow)
    with ThreadPoolExecutor(1) as pool:
        pending=pool.submit(lambda:a.post(f'/api/documents/{did}/ai-extraction'))
        assert started.wait(3)
        assert a.post(f'/api/documents/{did}/ai-extraction').status_code==409
        assert a.delete(f'/api/documents/{did}').status_code==200
        release.set();assert pending.result().status_code==404
    with env.db() as con:
        assert con.execute('SELECT COUNT(*) FROM document_analyses').fetchone()[0]==0


def test_old_foreign_reading_is_refreshed_once(env, monkeypatch):
    import json
    configure(monkeypatch)
    a=client(env)
    did=a.post('/api/documents',files={'file':('ejemplo.pdf',pdf(),'application/pdf')}).json()['id']
    with env.db() as con:
        old=json.loads(con.execute('SELECT result FROM document_analyses WHERE document_id=?',(did,)).fetchone()[0])
        old['classification'].update(issuer_country='IE',is_spanish=False)
        con.execute('UPDATE document_analyses SET result=? WHERE document_id=?',(json.dumps(old),did))
    calls=[]
    def refreshed(*args):
        calls.append(True)
        return {**old,'extraction_version':2,'fields':{'lines':[{'base':6998,'vat_rate':21}]}}
    monkeypatch.setattr(document_ai,'analyze',refreshed)
    r=a.post(f'/api/documents/{did}/prepare').json()
    assert not r['cached'] and r['fields']['lines'][0]['base']==6998
    assert a.post(f'/api/documents/{did}/prepare').json()['cached']
    assert len(calls)==1


def test_bulk_unattached_delete_protects_linked_foreign_and_new_documents(env, monkeypatch):
    configure(monkeypatch)
    a, b = client(env), client(env, 'bob')
    first = a.post('/api/documents', files={'file': ('one.pdf', pdf('ONE'), 'application/pdf')}).json()['id']
    linked = a.post('/api/documents', files={'file': ('two.pdf', pdf('TWO'), 'application/pdf')}).json()['id']
    foreign = b.post('/api/documents', files={'file': ('foreign.pdf', pdf('FOREIGN'), 'application/pdf')}).json()['id']
    newer = a.post('/api/documents', files={'file': ('new.pdf', pdf('NEW'), 'application/pdf')}).json()['id']
    assert a.post('/api/invoices', json=invoice(document_id=linked)).status_code == 200
    result = a.post('/api/documents/delete-unattached', json={'document_ids': [first, first, linked, foreign, 'missing']})
    assert result.status_code == 200, result.text
    assert result.json()['deleted_ids'] == [first]
    assert set(result.json()['skipped_ids']) == {linked, foreign, 'missing'}
    assert a.get(f'/api/documents/{first}').status_code == 404
    assert a.get(f'/api/documents/{linked}').status_code == 200
    assert a.get(f'/api/documents/{newer}').status_code == 200
    assert b.get(f'/api/documents/{foreign}').status_code == 200
    with env.db() as con:
        assert not con.execute('SELECT 1 FROM document_analyses WHERE document_id=?', (first,)).fetchone()
