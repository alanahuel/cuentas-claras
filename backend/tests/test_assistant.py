from concurrent.futures import ThreadPoolExecutor
from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest
from app import assistant
from test_app import env, client

@pytest.fixture
def enabled(env, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-never-sent')
    monkeypatch.setenv('ASSISTANT_MODEL', 'test-model')
    monkeypatch.setattr(assistant, 'request_answer', lambda q: ('Abre Facturas y gastos.', 100))
    return env

def test_auth_validation_and_disabled(env, monkeypatch):
    monkeypatch.delenv('ASSISTANT_MODEL', raising=False)
    assert TestClient(env.app).get('/api/assistant').status_code == 401
    c = client(env)
    assert c.get('/api/assistant').json()['available'] is False
    assert c.post('/api/assistant', json={'question':'Hola'}).status_code == 503
    c.headers['X-CSRF-Token'] = 'incorrect'
    assert c.post('/api/assistant', json={'question':'Hola'}).status_code == 403

def test_actor_quota_and_validation(enabled, monkeypatch):
    seen = []
    monkeypatch.setenv('ASSISTANT_DAILY_LIMIT', '2')
    monkeypatch.setattr(assistant, 'request_answer', lambda q: (seen.append(q) or 'Ayuda', 100))
    c = client(enabled)
    for q in ['', ' '*3, 'x'*1201]:
        assert c.post('/api/assistant', json={'question':q}).status_code == 422
    assert c.post('/api/assistant', json={'question':'Hola','user_id':'bob'}).status_code == 422
    c.headers['X-Workspace-Id'] = 'bob'
    for _ in range(2):
        r = c.post('/api/assistant', json={'question':'¿Cómo registro un gasto?'})
        assert r.status_code == 200
    assert r.json()['usage']['remaining_today'] == 0
    assert c.post('/api/assistant', json={'question':'Otra'}).status_code == 429
    assert len(seen) == 2
    assert client(enabled, 'bob').get('/api/assistant').json()['remaining_today'] == 2
    from fastapi import FastAPI
    app = FastAPI()
    assistant.install_assistant(app, enabled.db, enabled.current_user)
    other = TestClient(app); other.cookies.update(c.cookies)
    assert other.get('/api/assistant').json()['remaining_today'] == 0

def test_global_and_monthly_limits(enabled, monkeypatch):
    monkeypatch.setenv('ASSISTANT_GLOBAL_DAILY_LIMIT', '1')
    assert client(enabled).post('/api/assistant', json={'question':'Hola'}).status_code == 200
    b = client(enabled,'bob')
    assert b.post('/api/assistant', json={'question':'Hola'}).status_code == 429
    assert b.get('/api/assistant').json()['global_limit_reached'] is True
    monkeypatch.setenv('ASSISTANT_GLOBAL_DAILY_LIMIT', '200')
    monkeypatch.setenv('ASSISTANT_MONTHLY_TOKENS', '1')
    assert b.post('/api/assistant', json={'question':'Hola'}).status_code == 429
    monkeypatch.setenv('ASSISTANT_MONTHLY_TOKENS', '100000')
    monkeypatch.setenv('ASSISTANT_GLOBAL_MONTHLY_TOKENS', '1')
    assert b.post('/api/assistant', json={'question':'Hola'}).status_code == 429

def test_atomic_reservation_and_failure(enabled, monkeypatch):
    monkeypatch.setenv('ASSISTANT_GLOBAL_DAILY_LIMIT', '1')
    def fail(q): raise HTTPException(503, 'Proveedor no disponible')
    monkeypatch.setattr(assistant, 'request_answer', fail)
    a, b = client(enabled), client(enabled,'bob')
    with ThreadPoolExecutor(2) as pool:
        codes = list(pool.map(lambda c: c.post('/api/assistant', json={'question':'Hola'}).status_code, [a,b]))
    assert sorted(codes) == [429,503]
    with enabled.db() as con:
        assert con.execute("SELECT requests FROM assistant_usage WHERE scope='global' AND period LIKE 'day:%'").fetchone()[0] == 1
        assert con.execute("SELECT tokens FROM assistant_usage WHERE scope='global' AND period LIKE 'month:%'").fetchone()[0] > 600

def test_provider_contract(monkeypatch):
    import json
    monkeypatch.setenv('OPENAI_API_KEY','not-a-real-key')
    monkeypatch.setenv('ASSISTANT_MODEL','test-model')
    class Response:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def read(self,n):
            return json.dumps({'status':'completed','usage':{'total_tokens':75},'output':[
                {'type':'message','role':'assistant','content':[{'type':'output_text','text':'Respuesta'}]}
            ]}).encode()
    def fake(request, timeout):
        data = json.loads(request.data)
        assert data['store'] is False and data['max_output_tokens'] == 600
        assert data['input'] == [{'role':'user','content':'Pregunta'}]
        assert 'tools' not in data and 'previous_response_id' not in data
        assert timeout == 30
        return Response()
    monkeypatch.setattr(assistant,'urlopen',fake)
    assert assistant.request_answer('Pregunta') == ('Respuesta',75)
    def fail(*args,**kwargs): raise TimeoutError('secret-provider-detail')
    monkeypatch.setattr(assistant,'urlopen',fail)
    with pytest.raises(HTTPException) as caught: assistant.request_answer('Pregunta')
    assert 'secret-provider-detail' not in caught.value.detail

def test_counter_rollover_and_rate_limit(enabled, monkeypatch):
    c = client(enabled)
    monkeypatch.setattr(assistant,'periods', lambda: ('2026-09-30','2026-09','1'))
    for _ in range(3):
        assert c.post('/api/assistant', json={'question':'Hola'}).status_code == 200
    assert c.post('/api/assistant', json={'question':'Hola'}).status_code == 429
    monkeypatch.setattr(assistant,'periods', lambda: ('2026-10-01','2026-10','2'))
    assert c.get('/api/assistant').json()['remaining_today'] == 20
    assert c.get('/api/assistant').json()['remaining_monthly_tokens'] == 100000

def test_conversations_private_context_replay_and_deletion(enabled, monkeypatch):
    import uuid
    seen=[]
    monkeypatch.setattr(assistant,'request_answer',lambda messages:(seen.append(messages) or 'Pulsa Guardar borrador.',123))
    a,b=client(enabled),client(enabled,'bob')
    thread=a.post('/api/assistant/conversations').json(); cid=thread['id']
    path='/api/assistant/conversations/'+cid
    body={'question':'¿Cómo registro un gasto?', 'request_id':str(uuid.uuid4())}
    assert b.get(path).status_code==404
    assert b.post(path+'/messages',json=body).status_code==404
    assert b.delete(path).status_code==404
    assert b.get('/api/assistant/conversations').json()==[]
    assert a.post(path+'/messages',json=body).status_code==200
    assert a.post(path+'/messages',json=body).status_code==200
    assert len(seen)==1
    assert a.get('/api/assistant').json()['remaining_today']==19
    assert a.post(path+'/messages',json={**body,'question':'Otro texto'}).status_code==409
    assert a.post(path+'/messages',json={'question':'¿Y después?', 'request_id':str(uuid.uuid4())}).status_code==200
    assert seen[1]==[{'role':'user','content':body['question']},{'role':'assistant','content':'Pulsa Guardar borrador.'},{'role':'user','content':'¿Y después?'}]
    rows=a.get(path).json()['turns']; assert len(rows)==2 and all(r['state']=='completed' for r in rows)
    assert a.get('/api/assistant/conversations').json()[0]['title']==body['question']
    second=a.post('/api/assistant/conversations').json()['id']
    assert a.post('/api/assistant/conversations/'+second+'/messages',json={'question':'Nueva duda','request_id':str(uuid.uuid4())}).status_code==200
    assert len(seen[-1])==1
    assert a.delete(path).status_code==200
    assert a.get(path).status_code==404
    assert a.get('/api/assistant').json()['remaining_today']==17
    with enabled.db() as con:
        assert con.execute('SELECT COUNT(*) FROM assistant_turns WHERE conversation_id=?',(cid,)).fetchone()[0]==0

def test_pending_turn_serialization_and_recovery(enabled, monkeypatch):
    import threading,uuid,time
    started,release=threading.Event(),threading.Event()
    def slow(messages):
        started.set(); release.wait(5); return ('Respuesta',100)
    monkeypatch.setattr(assistant,'request_answer',slow)
    a=client(enabled); cid=a.post('/api/assistant/conversations').json()['id'];path='/api/assistant/conversations/'+cid
    body={'question':'Hola','request_id':str(uuid.uuid4())}
    with ThreadPoolExecutor(1) as pool:
        future=pool.submit(lambda:a.post(path+'/messages',json=body))
        assert started.wait(3)
        assert a.post(path+'/messages',json=body).status_code==409
        assert a.post(path+'/messages',json={**body,'request_id':str(uuid.uuid4())}).status_code==409
        release.set(); assert future.result().status_code==200
    assert a.get('/api/assistant').json()['remaining_today']==19
    with enabled.db() as con:
        con.execute("INSERT INTO assistant_turns(conversation_id,request_id,question,state,created) VALUES(?,?,?,'pending',?)",(cid,str(uuid.uuid4()),'Pendiente antiguo',int(time.time())-121))
    assert a.get(path).json()['turns'][-1]['state']=='failed'

def test_history_window_is_bounded():
    rows=[{'question':str(i),'answer':'a'*1500} for i in range(20)]
    messages=assistant.conversation_context(rows,'Nueva')
    assert len(messages)==11
    assert messages[0]['content']=='15'
    assert sum(len(m['content']) for m in messages[:-1]) <= 8000

def test_conversation_errors_keep_reservation_and_account_cascade(enabled, monkeypatch):
    import uuid
    a=client(enabled);cid=a.post('/api/assistant/conversations').json()['id'];path='/api/assistant/conversations/'+cid
    def fail(messages): raise HTTPException(503,'Error del proveedor')
    monkeypatch.setattr(assistant,'request_answer',fail)
    body={'question':'Pregunta','request_id':str(uuid.uuid4())}
    assert a.post(path+'/messages',json=body).status_code==503
    assert a.get(path).json()['turns'][0]['state']=='failed'
    assert a.post(path+'/messages',json=body).status_code==409
    assert a.get('/api/assistant').json()['remaining_today']==19
    r=a.request('DELETE','/api/account',json={'current_password':'a-secure-password','confirmation':'ELIMINAR'})
    assert r.status_code==200
    with enabled.db() as con:
        assert con.execute('SELECT COUNT(*) FROM assistant_conversations').fetchone()[0]==0
        assert con.execute('SELECT COUNT(*) FROM assistant_turns').fetchone()[0]==0
        assert con.execute("SELECT requests FROM assistant_usage WHERE scope='global' AND period LIKE 'day:%'").fetchone()[0]==1
