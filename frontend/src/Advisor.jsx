import React, { useEffect, useState } from "react";
import { ArrowRight, RefreshCw, Search } from "lucide-react";

const labels = { open: "Esperando al cliente", answered: "Respuesta por revisar", resolved: "Resuelta" };
const dateTime = (at) => new Date(at * 1000).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });

export function AdvisorWorkbench({ api, onOpen, onManage }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(""), [filter, setFilter] = useState("reviews");
  async function load() {
    setBusy(true); setError("");
    try { setData(await api("/advisor/workbench")); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []);
  const matches = (name) => name.toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es").trim());
  const clients = data?.clients.filter(c => matches(c.name)) || [];
  const reviews = data?.reviews.filter(r => matches(r.client_name)) || [];
  return <section className="advisor-workbench" aria-label="Mesa de trabajo">
    <div className="advisor-toolbar">
      <label className="advisor-search"><Search size={18} /><span className="sr-only">Buscar en la mesa de trabajo</span><input type="search" placeholder="Buscar cliente…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <button className="button" onClick={load} disabled={busy}><RefreshCw size={16} />{busy ? "Actualizando…" : "Actualizar"}</button>
      <button className="button" onClick={onManage}>Administrar cartera</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p role="status">Cargando el trabajo de tus clientes…</p>}
    {data && <>
      <div className="advisor-tabs" aria-label="Trabajo por atender">
        <button aria-pressed={filter === "reviews"} onClick={() => setFilter("reviews")}>Para revisar <b>{data.reviews.length}</b></button>
        <button aria-pressed={filter === "answers"} onClick={() => setFilter("answers")}>Respuestas <b>{data.clients.reduce((n,c) => n + c.requests_answered, 0)}</b></button>
        <button aria-pressed={filter === "clients"} onClick={() => setFilter("clients")}>Expedientes <b>{data.clients.length}</b></button>
      </div>
      {filter === "reviews" ? <>
        <div className="section-heading"><h2>Documentos enviados a revisión</h2><span className="muted">Todos los periodos · más antiguos primero</span></div>
        {reviews.length ? <div className="advisor-review-list">{reviews.map(r => <div className="advisor-review-row" key={r.id}>
          <div><strong>{r.client_name}</strong><span>{r.party || "Sin tercero"} · {r.number || "Sin número"}</span></div>
          <time dateTime={r.date}>{r.date.split("-").reverse().join("/")}</time>
          <button className="button" onClick={() => onOpen(r.client_id, "dossier", "", r.id)} aria-label={`Revisar ${r.number || "documento"} de ${r.client_name}`}>Revisar <ArrowRight size={16} /></button>
        </div>)}</div> : <div className="advisor-empty"><h3>{search ? "No hay revisiones para esta búsqueda" : "No hay documentos enviados por revisar"}</h3><p>Los borradores sin enviar y los archivos sin registrar se consultan en cada expediente.</p><button className="button" onClick={() => setFilter("clients")}>Ver expedientes</button></div>}
      </> : <>
        <div className="section-heading"><h2>{filter === "answers" ? "El cliente ya ha respondido" : "Seguimiento de clientes"}</h2><span className="muted">Pendientes de todos los periodos</span></div>
        {clients.filter(c => filter !== "answers" || c.requests_answered > 0).map(c => <div className="advisor-client-row" key={c.id}>
          <div><h3>{c.name}</h3><small>{c.agency_name}{!c.has_login ? " · Activación pendiente" : ""}</small><p>{c.submitted} por revisar · {c.changes_requested} con cambios pedidos · {c.unattached} sin registrar</p><p>{c.requests_open} solicitudes abiertas · {c.requests_answered} respuestas</p></div>
          <button className="button" onClick={() => onOpen(c.id, filter === "answers" ? "requests" : "dossier")}>Abrir expediente <ArrowRight size={16} /></button>
        </div>)}
        {!clients.some(c => filter !== "answers" || c.requests_answered > 0) && <div className="advisor-empty"><h3>{filter === "answers" ? "No hay respuestas pendientes" : "No hay clientes en esta vista"}</h3><p>{search ? "Prueba con otro nombre." : "Los clientes con acceso activo aparecerán aquí."}</p></div>}
      </>}
    </>}
  </section>;
}

export function ClientDossier({ user, items, unattached, year, quarter, onNavigate, onEdit, managed }) {
  const submitted = items.filter(i => i.status === "draft" && i.review_state === "submitted");
  const pending = items.filter(i => i.status === "draft");
  const period = items.filter(i => i.date.startsWith(String(year)) && Math.ceil(Number(i.date.slice(5,7))/3) === quarter);
  return <section className="client-dossier" aria-label={`Expediente de ${user.name}`}>
    <div className="dossier-main">
      <h2>Trabajo de revisión</h2>
      <p className="muted">Documentos de todos los periodos. Revisa los datos y el original antes de aprobar.</p>
      {submitted.length ? <><p><strong>{submitted.length} documento(s) enviado(s) por el cliente</strong></p><button className="button primary" onClick={() => onEdit(submitted[submitted.length - 1])}>Revisar el siguiente <ArrowRight size={16} /></button></> : <p>No hay documentos enviados pendientes de aprobación.</p>}
      <div className="dossier-task"><div><strong>Cola de documentos</strong><span>{pending.length} pendientes · {unattached.length} archivos sin registrar</span></div><button className="button" onClick={() => onNavigate("pending")}>Revisar documentos</button></div>
      {!managed && <div className="dossier-task"><div><strong>Chat con el cliente</strong><span>Mensajes, fotos y notas de voz en una conversación privada.</span></div><button className="button" onClick={() => onNavigate("chat")}>Abrir chat</button></div>}
      <div className="dossier-task"><div><strong>Solicitudes y respuestas</strong><span>{managed ? "Este cliente aún no tiene acceso propio para responder." : "Pide documentación o aclara dudas con el cliente."}</span></div><button className="button" onClick={() => onNavigate("requests")}>Ver solicitudes</button></div>
    </div>
    <aside className="dossier-quarter">
      <h2>Preparar T{quarter} de {year}</h2>
      <p>{period.filter(i => i.status === "confirmed").length} registros revisados · {period.filter(i => i.status === "draft").length} borradores del trimestre</p>
      <button className="text-button" onClick={() => onNavigate("settings")}>Comprobar perfil fiscal <ArrowRight size={16} /></button>
      <button className="text-button" onClick={() => onNavigate("tax")}>Revisar estimaciones y ajustes <ArrowRight size={16} /></button>
      <button className="text-button" onClick={() => onNavigate("invoices")}>Preparar paquete del trimestre <ArrowRight size={16} /></button>
      <small>El paquete reúne los registros y documentos. No presenta declaraciones ni acredita el cierre fiscal.</small>
    </aside>
  </section>;
}

export function ServiceRequests({ api, delegated, managed, compact = false, onOpen, onUpload }) {
  const [rows,setRows] = useState(null), [error,setError] = useState(""), [busy,setBusy] = useState(false), [title,setTitle] = useState(""), [body,setBody] = useState("");
  async function load() { try { setRows(await api("/service-requests")); setError(""); } catch(e) { setError(e.message); } }
  useEffect(() => { load(); }, []);
  async function run(task) { setBusy(true); setError(""); try { await task(); await load(); return true; } catch(e) { setError(e.message); return false; } finally { setBusy(false); } }
  if (compact) return <>{error && <p className="error" role="alert">{error}</p>}{rows?.some(r => r.status === "open") && <div className="banner"><span>Tu gestoría necesita información: {rows.filter(r => r.status === "open").length} solicitud(es) pendiente(s).</span><button className="button" onClick={onOpen}>Responder a la gestoría</button></div>}</>;
  return <section className="service-requests" aria-label="Solicitudes y respuestas">
    <div className="section-heading"><h2>{delegated ? "Seguimiento con el cliente" : "Solicitudes de tu gestoría"}</h2><button className="button" disabled={busy} onClick={() => run(load)}>Actualizar</button></div>
    <p className="muted">Este historial es compartido con el cliente y sus gestores autorizados. Las solicitudes se consultan aquí, sin envío de correo.</p>
    {managed && <p className="banner">Este cliente no tiene acceso propio. Puedes registrar solicitudes, pero no recibirá ni podrá responder mensajes desde una cuenta.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {delegated && <details className="request-create"><summary>Pedir documentación o información</summary><form onSubmit={e => { e.preventDefault(); run(async () => { await api("/service-requests", { method: "POST", body: JSON.stringify({title,body}) }); setTitle(""); setBody(""); }); }}>
      <label className="field"><span>Asunto</span><input required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} placeholder="Por ejemplo, factura de suministros de septiembre" /></label>
      <label className="field"><span>Qué necesitas del cliente</span><textarea required maxLength={3000} value={body} onChange={e => setBody(e.target.value)} /></label>
      <button className="button primary" disabled={busy || !title.trim() || !body.trim()}>Crear solicitud</button>
    </form></details>}
    {!rows && <p role="status">Cargando solicitudes…</p>}
    {rows?.length === 0 && <p className="advisor-empty">Todavía no hay solicitudes en este expediente.</p>}
    {rows?.map(r => <RequestThread key={r.id} row={r} delegated={delegated} busy={busy} onUpload={onUpload} onAction={(action,body) => run(() => api(`/service-requests/${r.id}`,{method:"POST",body:JSON.stringify({version:r.version,action,body})}))} />)}
  </section>;
}
function RequestThread({ row, delegated, busy, onAction, onUpload }) {
  const [reply,setReply] = useState("");
  return <article className="request-thread"><div className="section-heading"><h3>{row.title}</h3><span className={`status ${row.status === "resolved" ? "confirmed" : "draft"}`}>{labels[row.status]}</span></div>
    <ol>{row.messages.map((m,index) => <li key={index}><div><strong>{m.actor_name} · {m.role === "advisor" ? "Gestoría" : "Cliente"}</strong><time>{dateTime(m.at)}</time></div><p>{m.body}</p></li>)}</ol>
    {row.status !== "resolved" && <form onSubmit={async e => { e.preventDefault(); if (await onAction("reply",reply)) setReply(""); }}><label className="field"><span>Respuesta a «{row.title}»</span><textarea required maxLength={3000} value={reply} onChange={e => setReply(e.target.value)} /></label><div className="advisor-toolbar"><button className="button primary" disabled={busy || !reply.trim()}>Enviar respuesta</button>{!delegated && <button type="button" className="button" onClick={onUpload}>Añadir documento</button>}</div></form>}
    {delegated && <button className="text-button" disabled={busy} onClick={() => onAction(row.status === "resolved" ? "reopen" : "resolve", "")}>{row.status === "resolved" ? "Reabrir solicitud" : "Marcar como resuelta"}</button>}
  </article>;
}
