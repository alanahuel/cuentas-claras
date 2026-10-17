"""Participant-only messaging; access follows live client/manager assignments."""
import hashlib
import io
import re
import time
import uuid
from PIL import Image, ImageOps, UnidentifiedImageError
from fastapi import Depends, HTTPException, UploadFile, Form, Response, Request
from pydantic import BaseModel, Field


def install_chat(app, db, current_user):
    with db() as con:
        con.executescript('''
        CREATE TABLE IF NOT EXISTS chats(
            id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            advisor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(client_id,advisor_id));
        CREATE TABLE IF NOT EXISTS chat_messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            sender_id TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL,
            request_id TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', attachment BLOB,
            UNIQUE(chat_id,sender_id,request_id));
        CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(chat_id,id);
        CREATE TABLE IF NOT EXISTS chat_reads(
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            last_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_id,user_id));
        ''')

    def contacts(con, uid):
        pairs = con.execute('''
          SELECT c.client_id,c.manager_id AS advisor_id FROM client_access c
          JOIN agencies a ON a.user_id=c.manager_id
          WHERE a.enabled=1 AND c.archived=0 AND EXISTS(SELECT 1 FROM users cu WHERE cu.id=c.client_id AND cu.password<>'!no-login') AND (c.client_id=? OR c.manager_id=?)
          UNION
          SELECT c.client_id,t.member_id AS advisor_id FROM team_assignments t
          JOIN team_members m ON m.manager_id=t.manager_id AND m.member_id=t.member_id
          JOIN client_access c ON c.manager_id=t.manager_id AND c.client_id=t.client_id
          JOIN agencies a ON a.user_id=c.manager_id
          WHERE a.enabled=1 AND c.archived=0 AND EXISTS(SELECT 1 FROM users cu WHERE cu.id=c.client_id AND cu.password<>'!no-login') AND (c.client_id=? OR t.member_id=?)
        ''', (uid,uid,uid,uid)).fetchall()
        result = []
        for pair in pairs:
            cid, aid = pair['client_id'], pair['advisor_id']
            if cid == aid:
                continue
            other = aid if uid == cid else cid
            name = con.execute('SELECT name FROM users WHERE id=?',(other,)).fetchone()[0]
            result.append({'id':hashlib.sha256(f'{cid}:{aid}'.encode()).hexdigest(), 'client_id':cid,
                           'advisor_id':aid,'name':name,'role':'Gestor' if uid == cid else 'Cliente'})
        return result

    def authorized(con, chat_id, uid):
        match = next((c for c in contacts(con,uid) if c['id']==chat_id),None)
        if not match:
            raise HTTPException(403,'Esta conversación no está disponible. Comprueba la vinculación con tu gestoría.')
        return match

    @app.get('/api/chat')
    def inbox(user=Depends(current_user)):
        with db() as con:
            rows = contacts(con,user['id'])
            for row in rows:
                last = con.execute('SELECT body,mime,created,id FROM chat_messages WHERE chat_id=? ORDER BY id DESC LIMIT 1',(row['id'],)).fetchone()
                row['last'] = dict(last) if last else None
                row['unread'] = con.execute('''SELECT COUNT(*) FROM chat_messages WHERE chat_id=? AND sender_id<>?
                  AND id>COALESCE((SELECT last_id FROM chat_reads WHERE chat_id=? AND user_id=?),0)''',
                  (row['id'],user['id'],row['id'],user['id'])).fetchone()[0]
            return sorted(rows,key=lambda r: (-(r['last']['id'] if r['last'] else 0),r['name']))

    @app.get('/api/chat/{chat_id}/messages')
    def messages(chat_id: str, after: int = 0, before: int = 0, user=Depends(current_user)):
        if after < 0 or before < 0 or (after and before):
            raise HTTPException(422,'Página de conversación no válida.')
        with db() as con:
            authorized(con,chat_id,user['id'])
            rows = con.execute('''SELECT id,sender_id,body,created,mime FROM chat_messages
                WHERE chat_id=? AND id>? AND (?=0 OR id<?) ORDER BY id ''' + ('ASC' if after else 'DESC') + ' LIMIT 100',
                (chat_id,after,before,before)).fetchall()
            return sorted([dict(r) for r in rows],key=lambda r:r['id'])

    @app.post('/api/chat/{chat_id}/messages')
    def send(chat_id: str, body: str = Form(''), request_id: str = Form(...),
             file: UploadFile | None = None, user=Depends(current_user)):
        body = body.strip()
        if len(body)>4000:
            raise HTTPException(422,'El mensaje supera 4.000 caracteres.')
        try:
            uuid.UUID(request_id)
        except ValueError:
            raise HTTPException(422,'Identificador de envío no válido.')
        with db() as con:
            authorized(con,chat_id,user['id'])
        payload, mime = None, ''
        if file:
            raw = file.file.read(8*1024*1024+1)
            if len(raw)>8*1024*1024:
                raise HTTPException(413,'El archivo supera 8 MB.')
            if not raw:
                raise HTTPException(422,'El archivo está vacío.')
            if (file.content_type or '').startswith('image/'):
                try:
                    with Image.open(io.BytesIO(raw)) as photo:
                        if photo.width*photo.height>25_000_000:
                            raise ValueError('Imagen demasiado grande')
                        photo = ImageOps.exif_transpose(photo).convert('RGB')
                        photo.thumbnail((2400,2400))
                        out = io.BytesIO(); photo.save(out,format='JPEG',quality=88)
                        payload,mime = out.getvalue(),'image/jpeg'
                except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
                    raise HTTPException(422,'No se puede abrir la foto. Utiliza JPEG, PNG o WebP.')
            elif (file.content_type or '').startswith('audio/'):
                if raw.startswith(b'\x1aE\xdf\xa3'): mime='audio/webm'
                elif raw.startswith(b'OggS'): mime='audio/ogg'
                elif raw.startswith(b'RIFF') and raw[8:12]==b'WAVE': mime='audio/wav'
                elif raw[4:8]==b'ftyp': mime='audio/mp4'
                elif raw.startswith(b'ID3') or raw[:2] in (b'\xff\xfb',b'\xff\xf3',b'\xff\xf2'): mime='audio/mpeg'
                else: raise HTTPException(422,'Formato de audio no compatible. Graba una nota de voz desde el chat.')
                payload=raw
            else:
                raise HTTPException(422,'Solo se pueden enviar fotos o audio.')
        if not body and not payload:
            raise HTTPException(422,'Escribe un mensaje o añade una foto o audio.')
        with db() as con:
            con.execute('BEGIN IMMEDIATE')
            contact=authorized(con,chat_id,user['id'])
            existing=con.execute('SELECT id FROM chat_messages WHERE chat_id=? AND sender_id=? AND request_id=?',(chat_id,user['id'],request_id)).fetchone()
            if existing: return {'id':existing['id']}
            if con.execute('SELECT COUNT(*) FROM chat_messages WHERE sender_id=? AND created>?',(user['id'],int(time.time())-60)).fetchone()[0]>=40:
                raise HTTPException(429,'Has enviado muchos mensajes. Espera un minuto e inténtalo de nuevo.')
            if payload and con.execute('SELECT COALESCE(SUM(length(attachment)),0) FROM chat_messages WHERE chat_id=?',(chat_id,)).fetchone()[0]+len(payload)>100*1024*1024:
                raise HTTPException(413,'Esta conversación ha alcanzado el límite de 100 MB de archivos. Puedes seguir enviando texto.')
            con.execute('INSERT OR IGNORE INTO chats VALUES(?,?,?)',(chat_id,contact['client_id'],contact['advisor_id']))
            cursor=con.execute('INSERT INTO chat_messages(chat_id,sender_id,body,created,request_id,mime,attachment) VALUES(?,?,?,?,?,?,?)',
                (chat_id,user['id'],body,int(time.time()),request_id,mime,payload))
            return {'id':cursor.lastrowid}

    class ReadPosition(BaseModel):
        last_id: int = Field(ge=0)

    @app.post('/api/chat/{chat_id}/read')
    def mark_read(chat_id: str, body: ReadPosition, user=Depends(current_user)):
        with db() as con:
            authorized(con,chat_id,user['id'])
            last=con.execute('SELECT MAX(id) FROM chat_messages WHERE chat_id=? AND id<=?',(chat_id,body.last_id)).fetchone()[0]
            if last:
                con.execute('INSERT INTO chat_reads VALUES(?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)',(chat_id,user['id'],last))
            return {'ok':True}

    @app.get('/api/chat/{chat_id}/attachments/{message_id}')
    def attachment(chat_id: str, message_id: int, request: Request, user=Depends(current_user)):
        with db() as con:
            authorized(con,chat_id,user['id'])
            row=con.execute('SELECT mime,attachment FROM chat_messages WHERE chat_id=? AND id=?',(chat_id,message_id)).fetchone()
            if not row or not row['attachment']:
                raise HTTPException(404,'Archivo no encontrado.')
            data = bytes(row['attachment'])
            headers = {'Cache-Control':'no-store','Content-Disposition':'inline','Accept-Ranges':'bytes'}
            byte_range = request.headers.get('range')
            if byte_range:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)',byte_range)
                if not match or not any(match.groups()):
                    return Response(status_code=416,headers={'Content-Range':f'bytes */{len(data)}'})
                first,last=match.groups()
                start=int(first) if first else max(0,len(data)-int(last))
                end=min(int(last),len(data)-1) if first and last else len(data)-1
                if start>end or start>=len(data):
                    return Response(status_code=416,headers={'Content-Range':f'bytes */{len(data)}'})
                headers['Content-Range']=f'bytes {start}-{end}/{len(data)}'
                return Response(data[start:end+1],status_code=206,media_type=row['mime'],headers=headers)
            return Response(data,media_type=row['mime'],headers=headers)
