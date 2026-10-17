import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ImagePlus, Mic, Send, Square, X } from "lucide-react";

export function useChatUnread(api, uid) {
  const [count,setCount]=useState(0);
  useEffect(()=>{
    if(!uid){setCount(0);return;}
    let alive=true, running=false;
    const refresh=async()=>{if(running || document.hidden || !navigator.onLine)return; running=true;try{const rows=await api('/chat');if(alive)setCount(rows.reduce((n,c)=>n+c.unread,0));}catch{}finally{running=false;}};
    refresh();const timer=setInterval(refresh,8000);window.addEventListener('chat-read',refresh);
    return()=>{alive=false;clearInterval(timer);window.removeEventListener('chat-read',refresh);};
  },[uid]);
  return count;
}

export default function Chat({api, actor, initialClient}) {
  const [contacts,setContacts]=useState(null),[selected,setSelected]=useState(null),[error,setError]=useState('');
  const picked=useRef(false);
  useEffect(()=>{
    let alive=true,running=false;
    async function load(){if(running || document.hidden)return;running=true;try{
      const rows=await api('/chat');if(!alive)return;
      setContacts(rows);setError('');
      if(!picked.current && initialClient){const match=rows.find(c=>c.client_id===initialClient);if(match)setSelected(match.id);picked.current=true;}
    }catch(e){if(alive)setError(e.message);}finally{running=false;}}
    load();const timer=setInterval(load,3000);window.addEventListener('chat-read',load);
    return()=>{alive=false;clearInterval(timer);window.removeEventListener('chat-read',load);};
  },[]);
  const contact=contacts?.find(c=>c.id===selected);
  return <section className={`chat-layout ${selected ? 'chat-selected' : ''}`} aria-label="Chat con tu gestoría">
    <aside className="chat-contacts" aria-label="Conversaciones">
      <h2>Conversaciones</h2>
      <p>Clientes y gestores con vinculación activa.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!contacts && !error && <p role="status">Cargando conversaciones…</p>}
      {contacts?.length===0 && <p>No tienes contactos disponibles. Vincula una cuenta de cliente a su gestoría para empezar. Los clientes sin acceso propio no pueden recibir mensajes.</p>}
      {contacts?.map(c=><button key={c.id} className="chat-contact" aria-pressed={selected===c.id} onClick={()=>{picked.current=true;setSelected(c.id);}}>
        <span><strong>{c.name}</strong><small>{c.role}{c.unread ? ` · ${c.unread} sin leer` : ''}</small></span>
        <span className="chat-preview">{c.last?.body || (c.last?.mime.startsWith('image/') ? 'Foto' : c.last?.mime ? 'Nota de voz' : 'Iniciar conversación')}</span>
      </button>)}
    </aside>
    {contact ? <Conversation key={contact.id} api={api} contact={contact} actor={actor} onBack={()=>setSelected(null)} /> : <div className="chat-placeholder"><h2>{selected ? 'Conversación no disponible' : 'Habla con tu cliente o gestor'}</h2><p>{selected ? 'La vinculación puede haber cambiado. Selecciona otro contacto.' : 'Elige un contacto para enviar mensajes, fotos o notas de voz.'}</p>{selected && <button className="button" onClick={()=>setSelected(null)}>Volver a conversaciones</button>}</div>}
  </section>;
}
function Conversation({api,contact,actor,onBack}) {
  const [messages,setMessages]=useState([]),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[sending,setSending]=useState(false),[older,setOlder]=useState(false),[loadingOlder,setLoadingOlder]=useState(false);
  const [text,setText]=useState(''),[file,setFile]=useState(null),[preview,setPreview]=useState(''),[recording,setRecording]=useState(false),[arming,setArming]=useState(false),[seconds,setSeconds]=useState(0);
  const latest=useRef(0), scroller=useRef(null), atBottom=useRef(true),recorder=useRef(null), stream=useRef(null), clock=useRef(null),alive=useRef(true),sendId=useRef(crypto.randomUUID());
  const path=`/chat/${contact.id}`;
  useEffect(()=>{
    alive.current=true;let running=false;
    async function refresh(){if(running||document.hidden||!navigator.onLine)return;running=true;try{
      const rows=await api(`${path}/messages?after=${latest.current}`);if(!alive.current)return;
      if(!latest.current)setOlder(rows.length===100);
      if(rows.length){latest.current=Math.max(latest.current,rows.at(-1).id);setMessages(old=>[...old,...rows.filter(r=>!old.some(m=>m.id===r.id))]);}
      setLoaded(true);setError('');
      if(latest.current && atBottom.current){await api(`${path}/read`,{method:'POST',body:JSON.stringify({last_id:latest.current})});window.dispatchEvent(new Event('chat-read'));}
    }catch(e){if(alive.current)setError(e.message);}finally{running=false;}}
    refresh();const timer=setInterval(refresh,1500);
    window.addEventListener('online',refresh);
    return()=>{alive.current=false;clearInterval(timer);clearInterval(clock.current);if(recorder.current?.state==='recording')recorder.current.stop();stream.current?.getTracks().forEach(t=>t.stop());window.removeEventListener('online',refresh);};
  },[contact.id]);
  useEffect(()=>{if(atBottom.current&&scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;},[messages]);
  useEffect(()=>{if(!file){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  async function history(){setLoadingOlder(true);try{const rows=await api(`${path}/messages?before=${messages[0].id}`);setOlder(rows.length===100);atBottom.current=false;setMessages(old=>[...rows,...old]);}catch(e){setError(e.message);}finally{setLoadingOlder(false);}}
  function chooseFile(next){if(!next)return;if(next.size>8*1024*1024){setError('El archivo supera 8 MB.');return;}setFile(next);sendId.current=crypto.randomUUID();setError('');}
  async function record(){
    if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){setError('Este navegador no permite grabar. Puedes adjuntar un archivo de audio.');return;}
    setArming(true);
    try{
      const media=await navigator.mediaDevices.getUserMedia({audio:true});
      if(!alive.current){media.getTracks().forEach(t=>t.stop());return;}
      stream.current=media;const type=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
      const r=new MediaRecorder(media,type?{mimeType:type}:undefined);recorder.current=r;const chunks=[];
      r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      r.onstop=()=>{clearInterval(clock.current);media.getTracks().forEach(t=>t.stop());if(!alive.current)return;setRecording(false);chooseFile(new File(chunks,'nota-de-voz',{type:r.mimeType}));};
      r.onerror=()=>{clearInterval(clock.current);media.getTracks().forEach(t=>t.stop());if(alive.current){setRecording(false);setError('No se pudo grabar. Inténtalo de nuevo.');}};
      r.start();setRecording(true);setSeconds(0);setError('');let elapsed=0;clock.current=setInterval(()=>{elapsed++;setSeconds(elapsed);if(elapsed>=120&&r.state==='recording')r.stop();},1000);
    }catch{if(alive.current)setError('No se pudo acceder al micrófono. Permite su uso en el navegador o adjunta un audio.');}finally{if(alive.current)setArming(false);}
  }
  async function send(e){e.preventDefault();if(sending||recording||arming||(!text.trim()&&!file))return;setSending(true);setError('');
    const data=new FormData();data.append('body',text);data.append('request_id',sendId.current);if(file)data.append('file',file);
    try{await api(`${path}/messages`,{method:'POST',body:data});if(!alive.current)return;setText('');setFile(null);sendId.current=crypto.randomUUID();atBottom.current=true;
      window.dispatchEvent(new Event('chat-read'));
    }catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setSending(false);}}
  return <div className="chat-conversation">
    <header className="chat-header"><button className="button chat-back" onClick={onBack} aria-label="Volver a conversaciones"><ArrowLeft size={18}/></button><div><h2>{contact.name}</h2><p>{contact.role} · Escribes como {actor.name}</p></div></header>
    <div className="chat-messages" ref={scroller} role="log" aria-label={`Mensajes con ${contact.name}`} aria-live="polite" onScroll={()=>{const el=scroller.current;atBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;}}>
      {older && <button className="button" onClick={history} disabled={loadingOlder}>{loadingOlder?'Cargando…':'Ver mensajes anteriores'}</button>}
      {!loaded && !error && <p role="status">Cargando mensajes…</p>}
      {loaded && !messages.length && <p className="chat-empty">Puedes empezar con un mensaje. La conversación solo es visible para vosotros mientras la vinculación esté activa.</p>}
      {messages.map(m=><article key={m.id} className={`chat-message ${m.sender_id===actor.id?'mine':''}`}>
        <strong>{m.sender_id===actor.id?'Tú':contact.name}</strong>
        {m.mime.startsWith('image/') && <a href={`/api/chat/${contact.id}/attachments/${m.id}`} target="_blank" rel="noopener noreferrer"><img src={`/api/chat/${contact.id}/attachments/${m.id}`} alt={`Foto enviada por ${m.sender_id===actor.id?'ti':contact.name}`} loading="lazy" /></a>}
        {m.mime.startsWith('audio/') && <audio controls preload="none" src={`/api/chat/${contact.id}/attachments/${m.id}`} aria-label={`Audio de ${m.sender_id===actor.id?'ti':contact.name}`} />}
        {m.body && <p>{m.body}</p>}
        <time dateTime={new Date(m.created*1000).toISOString()}>{new Date(m.created*1000).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'short'})}</time>
      </article>)}
    </div>
    <form className="chat-composer" onSubmit={send}>
      {error && <p className="error" role="alert">{error}</p>}
      {file && <div className="chat-attachment-preview">{file.type.startsWith('image/')?<img src={preview} alt="Foto preparada para enviar"/>:<audio controls src={preview} aria-label="Escuchar nota antes de enviar"/>}<button type="button" className="button" disabled={sending} onClick={()=>setFile(null)} aria-label="Quitar adjunto"><X size={18}/></button></div>}
      <label className="field"><span>Mensaje para {contact.name}</span><textarea maxLength={4000} rows={2} value={text} disabled={sending} onChange={e=>{setText(e.target.value);sendId.current=crypto.randomUUID();}} placeholder="Escribe un mensaje…" /></label>
      <div className="chat-compose-actions">
        <label className="button chat-file"><ImagePlus size={18}/>Foto<input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Adjuntar foto" disabled={sending||recording||arming} onChange={e=>{chooseFile(e.target.files[0]);e.target.value='';}}/></label>
        {recording?<button type="button" className="button" onClick={()=>recorder.current?.stop()}><Square size={17}/>Detener · {seconds}s</button>:<button type="button" className="button" disabled={sending||arming} onClick={record}><Mic size={18}/>{arming?"Abriendo micrófono…":"Grabar audio"}</button>}
        <label className="button chat-file">Adjuntar audio<input type="file" accept="audio/*" aria-label="Adjuntar audio" disabled={sending||recording||arming} onChange={e=>{chooseFile(e.target.files[0]);e.target.value='';}}/></label>
        <button className="button primary" disabled={sending||recording||arming||(!text.trim()&&!file)}><Send size={17}/>{sending?'Enviando…':'Enviar'}</button>
      </div>
      <small>Fotos y audio: hasta 8 MB. Grabaciones: hasta 2 minutos. Los adjuntos del chat no se contabilizan como facturas.</small>
    </form>
  </div>;
}
