import React, { useEffect, useRef, useState } from "react";
import { Plus, X, Send, MessageCircle, Trash2 } from "lucide-react";

export default function Assistant({ api }) {
  const [usage, setUsage] = useState(null), [threads, setThreads] = useState(null);
  const [selected, setSelected] = useState(null), [error, setError] = useState("");
  const [creating, setCreating] = useState(false), [deleting, setDeleting] = useState(false);
  const alive = useRef(true), closeFocus = useRef(null);
  async function refresh() {
    const [u, rows] = await Promise.all([api('/assistant'), api('/assistant/conversations')]);
    if (alive.current) { setUsage(u); setThreads(rows); }
  }
  useEffect(() => {
    alive.current = true;
    refresh().catch(e => { if (alive.current) setError(e.message); });
    return () => { alive.current = false; };
  }, [api]);
  async function create() {
    if (creating) return;
    setCreating(true); setError('');
    try {
      const row = await api('/assistant/conversations', { method: 'POST' });
      if (!alive.current) return;
      setThreads(old => [row, ...(old || [])]); setSelected(row.id); setDeleting(false);
    } catch (e) { if (alive.current) setError(e.message); }
    finally { if (alive.current) setCreating(false); }
  }
  function close() { setSelected(null); setDeleting(false); closeFocus.current?.focus(); }
  async function remove() {
    try {
      await api(`/assistant/conversations/${selected}`, { method: 'DELETE' });
      if (!alive.current) return;
      setThreads(old => old.filter(t => t.id !== selected)); close();
    } catch (e) { if (alive.current) setError(e.message); }
  }
  function changed() { refresh().catch(e => { if (alive.current) setError(e.message); }); }
  return <section className={`assistant-chat ${selected ? 'assistant-selected' : ''}`} aria-label="Chat con el asistente">
    <aside className="assistant-history" aria-label="Tus conversaciones con IA">
      <button ref={closeFocus} className="button primary" onClick={create} disabled={creating}><Plus size={18} />{creating ? 'Creando…' : 'Nueva conversación'}</button>
      <h2>Conversaciones</h2>
      {!selected && error && <p className="error" role="alert">{error} <button className="text-button" onClick={() => { setError(''); changed(); }}>Actualizar</button></p>}
      {threads === null && !error && <p role="status">Cargando conversaciones…</p>}
      {threads?.length === 0 && <p className="assistant-note">Tus conversaciones aparecerán aquí. Puedes cerrarlas y retomarlas cuando quieras.</p>}
      <div className="assistant-thread-list">{threads?.map(t => <button key={t.id} className="assistant-thread" aria-label={`Abrir conversación: ${t.title}`} aria-current={selected === t.id ? 'true' : undefined} onClick={() => { setSelected(t.id); setDeleting(false); setError(''); }}>
        <MessageCircle size={17} /><span>{t.title}</span>
      </button>)}</div>
    </aside>
    <div className="assistant-main">
      <header className="assistant-chat-header"><div><h2>{selected ? threads?.find(t => t.id === selected)?.title || 'Conversación' : 'Asistente de Cuentas'}</h2>
        <p className="assistant-note" role="status">{usage ? usage.available ? `${usage.remaining_today} de ${usage.daily_limit} preguntas disponibles hoy` : 'El asistente todavía no está activado.' : 'Comprobando disponibilidad…'}</p>
      </div>{selected && <div className="assistant-header-actions">
        <button className="button" aria-label="Eliminar conversación" onClick={() => setDeleting(true)}><Trash2 size={18} /></button>
        <button className="button" aria-label="Cerrar conversación" onClick={close}><X size={18} /></button>
      </div>}</header>
      {selected && error && <p className="error" role="alert">{error} <button className="text-button" onClick={() => { setError(''); changed(); }}>Actualizar</button></p>}
      {deleting && <div className="assistant-delete" role="group" aria-label="Confirmar eliminación"><p>¿Eliminar esta conversación y sus mensajes? No podrás recuperarla.</p><button className="button" onClick={() => setDeleting(false)}>Cancelar</button><button className="button" onClick={remove}>Eliminar definitivamente</button></div>}
      {selected ? <Thread key={selected} id={selected} api={api} usage={usage} onChanged={changed} /> : <div className="assistant-welcome">
        <h3>¿En qué te ayudo con la app?</h3><p>Registrar un gasto, revisar documentos o preparar el trimestre. Abre una conversación y seguimos desde ahí.</p>
        <button className="button" onClick={create} disabled={creating}><Plus size={18} />Empezar una conversación</button>
        <p className="assistant-note">Solo tú puedes ver tus conversaciones. Se guardan en tu cuenta hasta que las elimines.</p>
      </div>}
    </div>
  </section>;
}

function Thread({ id, api, usage, onChanged }) {
  const [thread, setThread] = useState(null), [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), input = useRef(null), log = useRef(null), atBottom = useRef(true);
  const requestId = useRef(crypto.randomUUID());
  const path = `/assistant/conversations/${id}`;
  const pending = thread?.turns.some(t => t.state === 'pending');
  async function load() {
    const value = await api(path);
    if (alive.current) setThread(value);
    return value;
  }
  useEffect(() => {
    alive.current = true;
    load().catch(e => { if (alive.current) setError(e.message); });
    input.current?.focus();
    return () => { alive.current = false; };
  }, [id]);
  useEffect(() => {
    if (!pending || busy) return;
    const timer = setInterval(() => { load().catch(e => { if (alive.current) setError(e.message); }); }, 2000);
    return () => clearInterval(timer);
  }, [pending, busy]);
  useEffect(() => { if (atBottom.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [thread, busy]);
  async function send(event) {
    event.preventDefault();
    if (busy || pending || !question.trim()) return;
    setBusy(true); setError(''); atBottom.current = true;
    try {
      await api(`${path}/messages`, { method: 'POST', body: JSON.stringify({ question: question.trim(), request_id: requestId.current }) });
      if (!alive.current) { onChanged(); return; }
      setQuestion(''); requestId.current = crypto.randomUUID();
      // Delivery succeeded even if refreshing the visible history fails.
      try { await load(); } catch { setError('Mensaje enviado. Pulsa Actualizar para ver la respuesta.'); }
      onChanged();
    } catch (e) {
      if (!alive.current) return;
      setError(e.message);
      try {
        const value = await load();
        const sent = value.turns.find(t => t.request_id === requestId.current);
        if (sent?.state === 'completed') { setQuestion(''); setError(''); requestId.current = crypto.randomUUID(); }
        if (sent?.state === 'failed') requestId.current = crypto.randomUUID();
      } catch { /* Preserve request ID: reconnecting must not spend twice. */ }
      onChanged();
    } finally { if (alive.current) { setBusy(false); input.current?.focus(); } }
  }
  return <>
    <div ref={log} className="assistant-log" role="log" aria-label="Conversación con el asistente" aria-live="polite" onScroll={() => { const el = log.current; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {!thread && <p role="status">Cargando mensajes…</p>}
      {thread?.turns.length === 0 && <div className="assistant-starters"><h3>Empecemos por tu duda</h3><p>Puedes hacer preguntas de seguimiento en esta conversación.</p>{['¿Cómo registro un gasto?', '¿Cómo envío documentos a mi gestor?', '¿Cómo registro los impuestos pagados?'].map(text => <button className="button" key={text} onClick={() => { setQuestion(text); input.current?.focus(); }}>{text}</button>)}</div>}
      {thread?.turns.map(turn => <React.Fragment key={turn.id}>
        <article className="assistant-message assistant-user"><strong>Tú</strong><p>{turn.question}</p></article>
        {turn.state === 'completed' && <article className="assistant-message"><strong>Asistente de Cuentas</strong><p>{turn.answer}</p></article>}
        {turn.state === 'failed' && <p className="assistant-note">No se pudo completar esta respuesta. Puedes enviar de nuevo la pregunta; contará como otro intento.</p>}
      </React.Fragment>)}
      {(busy || pending) && <p className="assistant-thinking" role="status">El asistente está escribiendo…</p>}
    </div>
    <form onSubmit={send} className="assistant-composer" aria-busy={busy}>
      {error && <p className="error" role="alert">{error} <button type="button" className="text-button" onClick={() => load().then(() => setError('')).catch(e => setError(e.message))}>Actualizar</button></p>}
      <label className="field"><span>Mensaje al asistente</span><textarea ref={input} value={question} onChange={e => { setQuestion(e.target.value); requestId.current = crypto.randomUUID(); }} maxLength={1200} rows={2} required disabled={busy || pending} placeholder="Pregunta sobre Cuentas…" aria-describedby="assistant-privacy" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(min-width: 701px)').matches) { e.preventDefault(); if (usage?.available) send(e); } }} /></label>
      <div className="assistant-compose-actions"><small>{question.length}/1200 · Enter para enviar en escritorio</small><button className="button primary" disabled={busy || pending || !thread || !usage?.available || !question.trim()}><Send size={17} />Enviar</button></div>
      <small id="assistant-privacy">La pregunta y el contexto reciente se envían a OpenAI. No incluyas datos personales. No accede a tus facturas y puede equivocarse.</small>
    </form>
  </>;
}
