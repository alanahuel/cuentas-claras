import ReportSharing from "./ReportSharing";
import { documentFieldLabels, documentSuggestions, mergeDocumentSuggestions } from "./documentAutofill";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Files,
  ChartNoAxesCombined,
  Settings,
  ChevronDown,
  Info,
  LogOut,
  Plus,
  Upload,
  Camera,
  Printer,
  FileText,
  Check,
  ArrowRight,
  X,
  Trash2,
  Download,
  WifiOff,
  Search,
  ShieldCheck,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
} from "lucide-react";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "./styles.css";
import UnattachedDocuments from "./UnattachedDocuments";
import Assistant from "./Assistant";
import FinancialDashboard from "./FinancialDashboard";
import InvoiceChecks from "./InvoiceChecks";
import FiscalHelp, { FiscalReadiness } from "./FiscalHelp";
import { ClientActivationForm, ClientInvitation } from "./ClientAccess";
import Chat, { useChatUnread } from "./Chat";
import { AdvisorWorkbench, ClientDossier, ServiceRequests } from "./Advisor";
import { drafts, saveDraft, removeDraft, clearDrafts } from "./offline";

const money = (value) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(
    (value || 0) / 100,
  );
const decimal = (value) => (value / 100).toFixed(2);
const cents = (value) => {
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) throw new Error("Introduce un importe válido.");
  return Math.round(n * 100);
};
const today = () => new Date().toLocaleDateString("sv-SE");
let csrf = "";
let workspaceId = "";
const scopedUrl = (url) =>
  url +
  (url.includes("?") ? "&" : "?") +
  "workspace=" +
  encodeURIComponent(workspaceId);
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      "X-CSRF-Token": csrf,
      "X-Workspace-Id": workspaceId,
      ...options.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 401 && path !== "/login") window.dispatchEvent(new Event("session-ended"));
    let error;
    try {
      error = await response.json();
    } catch {
      error = { detail: "El servidor no ha respondido. Inténtalo de nuevo." };
    }
    const failure = new Error(
      typeof error.detail === "string"
        ? error.detail
        : "Revisa los campos: hay un valor no válido.",
    );
    failure.status = response.status;
    throw failure;
  }
  return response.json();
}
function Button({ children, icon: Icon, className = "", ...props }) {
  return (
    <button className={"button " + className} {...props}>
      {Icon && <Icon size={18} />} {children}
    </button>
  );
}
function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function ErrorBox({ message }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}
function App() {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("home"),
    [invoices, setInvoices] = useState([]),
    [unattached, setUnattached] = useState([]),
    [summary, setSummary] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editor, setEditor] = useState(null),
    [online, setOnline] = useState(navigator.onLine),
    [queue, setQueue] = useState([]),
    [busy, setBusy] = useState(false),
    [switching, setSwitching] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear()),
    [quarter, setQuarter] = useState(
      Math.ceil((new Date().getMonth() + 1) / 3),
    );
  const [actor, setActor] = useState(null),
    [spaces, setSpaces] = useState({ clients: [], managers: [], agency: null });
  const navigation = useRef(null);
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const revealSelection = () => {
      const selected = nav.querySelector('[aria-current="page"]');
      if (!selected || nav.scrollWidth <= nav.clientWidth) return;
      const item = selected.getBoundingClientRect(), strip = nav.getBoundingClientRect();
      nav.scrollLeft += item.left - strip.left - (nav.clientWidth - item.width) / 2;
    };
    revealSelection();
    const observer = new ResizeObserver(revealSelection);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [page, user?.id, loading]);
  const unreadChat = useChatUnread(api, actor?.id);
  const [chatClient, setChatClient] = useState(null);
  const openChat = (clientId = null) => { setChatClient(clientId); switchWorkspace("", "chat"); };
  const refreshSpaces = async (initial = false) => {
    const next = await api("/workspaces");
    setSpaces(next);
    if (initial) setPage(next.agency || next.memberships?.some(m => m.enabled) ? "workbench" : "home");
  };
  const deactivateAgency = async () => {
    if (editor || busy || queue.length) throw new Error("Cierra la revisión y sincroniza los borradores antes de cambiar el tipo de cuenta.");
    await api("/agency/deactivate", { method: "POST" });
    await refreshSpaces();
    await switchWorkspace("", "agency", "Tu cuenta vuelve a ser de autónomo. Los clientes se conservan con el acceso suspendido.");
  };
  const switchWorkspace = async (id, destination = id ? "dossier" : "home", message = "", invoiceId = null) => {
    if (editor || busy) return;
    if (queue.length) {
      setError(
        "Sincroniza los borradores o cierra sesión antes de cambiar de cliente.",
      );
      return;
    }
    setSwitching(true);
    ++loadSequence.current;
    const previous = workspaceId;
    workspaceId = id;
    setBusy(true);
    setError("");
    try {
      const next = await api("/workspace");
      const record = invoiceId ? (await api("/invoices")).find(r => r.id === invoiceId) : null;
      if (invoiceId && !record) throw new Error("Este documento ya no está disponible. Actualiza la mesa de trabajo.");
      setInvoices([]);
      setUnattached([]);
      setSummary(null);
      setQueue([]);
      setNotice(message);
      setPage(destination);
      setUser(next);
      if (record) setEditor(record);
    } catch (e) {
      workspaceId = previous;
      setError(e.message);
    } finally {
      setSwitching(false);
      setBusy(false);
    }
  };
  const loadSequence = useRef(0);
  const load = async () => {
    const sequence = ++loadSequence.current;
    setError("");
    try {
      const [rows, totals, documents] = await Promise.all([
        api("/invoices"),
        api(`/summary?year=${year}&quarter=${quarter}`),
        api("/documents"),
      ]);
      if (sequence !== loadSequence.current) return;
      setInvoices(rows);
      setSummary(totals);
      setUnattached(documents);
    } catch (e) {
      if (sequence === loadSequence.current) setError(e.message);
    }
  };
  useEffect(() => {
    api("/me")
      .then((u) => {
        csrf = u.csrf;
        workspaceId = "";
        setActor(u);
        refreshSpaces(true).catch((e) => setError(e.message));
        setUser(u);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    const on = () => setOnline(true),
      off = () => setOnline(false);
    const ended = () => { ++loadSequence.current; workspaceId = ""; csrf = ""; setUser(null); setActor(null); setPage("home"); setQueue([]); setEditor(null); setInvoices([]); setUnattached([]); setSummary(null); setSpaces({clients: [], managers: [], agency: null}); };
    window.addEventListener("session-ended", ended);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("session-ended", ended);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (user) {
      load();
      (user.delegated ? Promise.resolve([]) : drafts(user.id))
        .then((rows) => {
          if (!cancelled) setQueue(rows);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [user, year, quarter, online]);
  useEffect(() => {
    if (notice) {
      const id = setTimeout(() => setNotice(""), 6000);
      return () => clearTimeout(id);
    }
  }, [notice]);
  const logout = async () => {
    if (
      queue.length &&
      !window.confirm(
        "Hay borradores sin sincronizar. Si cierras sesión se eliminarán de este dispositivo. ¿Continuar?",
      )
    )
      return;
    try {
      await api("/logout", { method: "POST" });
      await clearDrafts(user.id);
      csrf = "";
      workspaceId = "";
      setActor(null);
      setSpaces({ clients: [], managers: [], agency: null });
      setUser(null);
      setInvoices([]);
      setUnattached([]);
      setSummary(null);
      setQueue([]);
      setPage("home");
    } catch (e) {
      setError(e.message);
    }
  };
  const sync = async () => {
    setBusy(true);
    setError("");
    try {
      for (const item of queue) {
        await api("/invoices", {
          method: "POST",
          body: JSON.stringify(item.payload),
        });
        await removeDraft(item.key);
      }
      setQueue(user.delegated ? [] : await drafts(user.id));
      await load();
      setNotice("Borradores sincronizados. Ya puedes revisarlos.");
    } catch (e) {
      setError(e.message);
      setQueue(user.delegated ? [] : await drafts(user.id));
    } finally {
      setBusy(false);
    }
  };
  const saved = async (message) => {
    setEditor(null);
    setNotice(message);
    setQueue(user.delegated ? [] : await drafts(user.id));
    if (navigator.onLine) await load();
  };
  if (switching) return <div className="loading" role="status"><LoaderCircle className="spin" />Abriendo el espacio seleccionado…</div>;
  if (loading)
    return (
      <div className="loading">
        <LoaderCircle className="spin" /> Abriendo tu espacio…
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          csrf = u.csrf;
          workspaceId = "";
          setActor(u);
          refreshSpaces(true).catch((e) => setError(e.message));
          setUser(u);
        }}
        online={online}
      />
    );
  const period = invoices.filter(
    (i) =>
      i.date.startsWith(String(year)) &&
      Math.ceil(Number(i.date.slice(5, 7)) / 3) === quarter,
  );
  const advisorMode = !!(spaces.agency || spaces.memberships?.some(m => m.enabled));
  const hasMessaging = advisorMode || spaces.managers?.some(m => m.enabled && !m.archived);
  const inAdvisorArea = user.delegated || (advisorMode && ["workbench", "agency", "chat", "assistant"].includes(page));
  const titles = {
    chat: "Mensajes",
    assistant: "Ayuda con IA",
    workbench: "Mesa de gestoría",
    dossier: `Expediente de ${user.name}`,
    requests: user.delegated ? "Solicitudes al cliente" : "Solicitudes de tu gestoría",
    agency: "Gestoría y accesos",
    pending: "Documentos pendientes",
    home: "Tu trimestre, en orden.",
    invoices: "Facturas y gastos",
    tax: "Resumen fiscal",
    settings: user.delegated ? `Perfil fiscal de ${user.name}` : "Editar perfil",
    information: "Información de tu cuenta",
  };
  return (
    <div className={`app ${page === "assistant" ? "assistant-page" : ""}`}>
      <aside className={`sidebar ${user.delegated ? "delegated" : ""}`}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (user.delegated || spaces.agency || spaces.memberships?.some(m => m.enabled)) switchWorkspace("", "workbench");
            else setPage("home");
          }}
        >
          <img src="/icon.svg" alt="" />
          Cuentas<span>facturas y gastos</span>
        </a>
        <nav ref={navigation} aria-label="Navegación principal">
          {(inAdvisorArea ? [
            ["workbench", LayoutDashboard, "Mesa de gestoría"],
            ["agency", Settings, "Clientes y equipo"],
            ["chat", MessageCircle, "Mensajes"],
            ["assistant", Info, "Ayuda con IA"],
          ] : [
            ["home", LayoutDashboard, "Vista general"],
            ["invoices", Files, "Facturas y gastos"],
            ["tax", ChartNoAxesCombined, "Resumen fiscal"],
            ["requests", FileText, "Mi gestoría"],
            ["chat", MessageCircle, "Mensajes"],
            ["assistant", Info, "Ayuda con IA"],
          ]).filter(([key]) => key !== "chat" || hasMessaging).map(([key, Icon, label]) => (
            <button
              key={key}
              data-page={key}
              aria-current={page === key || (key === "agency" && user.delegated) || (key === "invoices" && page === "pending") ? "page" : undefined}
              onClick={() => key === "chat" ? openChat() : ["workbench", "agency", "assistant"].includes(key) ? switchWorkspace("", key) : setPage(key)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {key === "chat" && unreadChat > 0 && <b aria-label={`${unreadChat} mensajes sin leer`}>{unreadChat}</b>}
              {key === "invoices" && summary?.pending > 0 && (
                <b>{summary.pending}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <p>
            <ShieldCheck size={17} /> Tu espacio privado
          </p>
          <small>Documentos privados de tu cuenta.</small>
        </div>
      </aside>
      <main>
        {(spaces.agency || spaces.memberships?.length || user.delegated) && (
          <div className="workspace-bar advisor-context">
            <div><strong>{page === "chat" ? "Mensajes privados" : user.delegated ? `Expediente · ${user.name}` : ["workbench", "agency"].includes(page) ? spaces.agency || "Equipo de gestoría" : "Mi actividad de autónomo"}</strong><span>{user.delegated ? `Gestor: ${actor?.name}. Las acciones se registran a tu nombre.` : `Sesión de ${actor?.name}`}</span></div>
            <Button disabled={busy || !!editor} onClick={() => switchWorkspace("", user.delegated || ["workbench", "agency"].includes(page) ? "home" : "workbench")}>{user.delegated || ["workbench", "agency"].includes(page) ? "Mi actividad personal" : "Ir a la gestoría"}</Button>
          </div>
        )}
        <header className="topbar">
          <span>
            {page === "chat" ? "Mi bandeja" : ["agency", "workbench"].includes(page) ? spaces.agency || "Gestoría" : user.delegated ? user.name : "Mi actividad"} <ChevronRight size={14} />{" "}
            {page === "home" ? "Vista general" : titles[page]}
          </span>
          <div className="topbar-actions">
            <div className="period" hidden={["agency", "pending", "workbench", "requests", "chat", "assistant"].includes(page)}>
              <label className="sr-only" htmlFor="quarter">
                Trimestre
              </label>
              <select
                id="quarter"
                value={quarter}
                onChange={(e) => setQuarter(Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>
                    {q}.º trimestre
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="year">
                Ejercicio
              </label>
              <input
                id="year"
                type="number"
                min="2000"
                max="2100"
                value={year}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (value >= 2000 && value <= 2100) setYear(value);
                }}
              />
            </div>
            <AccountMenu
              user={actor || user}
              onNavigate={(destination) => switchWorkspace("", destination)}
              onLogout={logout}
            />
          </div>
        </header>
        <div className="workspace">
          {!online && (
            <p className="banner">
              <WifiOff size={18} /> Sin conexión. Puedes guardar nuevos
              borradores en este dispositivo. Para cargar documentos o confirmar
              registros, vuelve a conectarte.
            </p>
          )}
          {queue.length > 0 && (
            <div className="banner">
              <span>
                {queue.length} borrador(es) guardados en este dispositivo.
              </span>
              <Button disabled={!online || busy} onClick={sync}>
                Sincronizar
              </Button>
            </div>
          )}
          <ErrorBox message={error} />
          {page === "home" && invoices.some((i) => i.review_state === "changes_requested") && <div className="banner"><span>Tu gestoría ha pedido cambios en {invoices.filter((i) => i.review_state === "changes_requested").length} documento(s).</span><Button onClick={() => setPage("pending")}>Ver cambios solicitados</Button></div>}
          {page === "home" && actor?.account_scope === "agency_client" && <p className="banner">Tu acceso está vinculado a la gestoría. Puedes compartir documentos y hablar con tu gestor desde Mensajes.</p>}
          {page === "home" && !user.delegated && <ServiceRequests api={api} compact onOpen={() => setPage("requests")} />}
          <div className="page-heading">
            <div>
              <h1>{titles[page]}</h1>
              <p>
                {page === "assistant" ? "Resuelve tus dudas sobre el uso de Cuentas." : page === "chat" ? "Mensajes, fotos y notas de voz con tus contactos autorizados." : page === "workbench" ? "Revisiones y respuestas de tus clientes, en un solo lugar."
                  : page === "dossier" ? "Revisa, resuelve dudas y prepara el trimestre de este cliente."
                  : page === "requests" ? "Información pendiente y conversaciones con seguimiento."
                  : page === "home"
                  ? `Lo importante de tu actividad · ${year} / T${quarter}`
                  : page === "invoices"
                    ? "Cada documento, revisado y en su sitio."
                    : page === "tax"
                      ? "Estimaciones con el detalle de los registros revisados."
                      : page === "pending"
                        ? `Todos los periodos · ${user.name}`
                        : page === "agency"
                        ? "Clientes, documentos pendientes y permisos de colaboración."
                        : "La configuración de esta cuenta es independiente."}
              </p>
            </div>
            {!["settings", "information", "agency", "workbench", "requests", "chat", "assistant"].includes(page) && (
              <Button
                className="primary"
                icon={Plus}
                onClick={() => setEditor({})}
              >
                Añadir documento
              </Button>
            )}
          </div>
          {user.delegated && <nav className="dossier-navigation" aria-label="Navegación del expediente">
            {[["dossier", "Resumen"], ["invoices", "Documentos"], ["tax", "Preparación fiscal"], ["requests", "Solicitudes"]].map(([key, label]) => (
              <button key={key} aria-current={page === key || (key === "invoices" && page === "pending") || (key === "tax" && page === "settings") ? "page" : undefined} onClick={() => setPage(key)}>{label}</button>
            ))}
          </nav>}
          {page === "assistant" && <Assistant api={api} />}
          {page === "chat" && <Chat api={api} actor={actor || user} initialClient={chatClient} />}
          {page === "workbench" && <AdvisorWorkbench api={api} onOpen={switchWorkspace} onManage={() => setPage("agency")} />}
          {page === "dossier" && user.delegated && <ClientDossier user={user} items={invoices} unattached={unattached} year={year} quarter={quarter} onNavigate={destination => destination === "chat" ? openChat(user.id) : setPage(destination)} onEdit={setEditor} managed={!spaces.clients.find(c => c.id === user.id)?.has_login} />}
          {page === "requests" && <ServiceRequests key={user.id} api={api} delegated={user.delegated} managed={user.delegated && !spaces.clients.find(c => c.id === user.id)?.has_login} onUpload={() => setEditor({})} />}
          {page === "home" && !user.delegated &&
            summary &&
            summary.year === year &&
            summary.quarter === quarter && (
              <>
                <FinancialDashboard summary={summary} year={year} quarter={quarter} api={api} reload={load} online={online}>
                  <div className="tax-preview">
                    <h2>Previsión de impuestos<span className="tax-period">{quarter}.º trimestre · {year}</span></h2>
                    <div className="tax-number">
                      {summary.reserve_complete
                        ? money(summary.tax_reserve)
                        : summary.vat_reserve !== null ||
                            summary.irpf_reserve !== null
                          ? money(summary.known_reserve)
                          : "Por configurar"}
                    </div>
                    <p>
                      {summary.reserve_complete
                        ? "Objetivo de reserva para este trimestre"
                        : "Previsión parcial · faltan datos fiscales"}
                    </p>
                    <dl className="reserve-breakdown">
                      <div>
                        <dt>IVA a ingresar</dt>
                        <dd>
                          {summary.vat_reserve === null
                            ? "Por configurar"
                            : money(summary.vat_reserve)}
                        </dd>
                      </div>
                      <div>
                        <dt>IRPF · pago fraccionado</dt>
                        <dd>
                          {summary.irpf_reserve === null
                            ? "Por configurar"
                            : summary.irpf_required === "no"
                              ? "Exoneración indicada"
                              : money(summary.irpf_reserve)}
                        </dd>
                      </div>
                    </dl>
                    <button
                      className="text-button"
                      onClick={() =>
                        setPage(summary.reserve_complete ? "tax" : "settings")
                      }
                    >
                      {summary.reserve_complete
                        ? "Ver el detalle"
                        : "Completar perfil fiscal"}
                      <ArrowRight size={17} />
                    </button>
                    <small>
                      Estimación de IVA y pago fraccionado de IRPF. No incluye
                      la Renta anual ni otras obligaciones. Los saldos negativos
                      de IVA no reducen la reserva de IRPF.
                    </small>
                  </div>
                </FinancialDashboard>
                <SavingsTracker
                  key={`${year}-${quarter}`}
                  summary={summary}
                  year={year}
                  quarter={quarter}
                  reload={load}
                  online={online}
                />
                <section className="next-step">
                  <div className="step-icon">
                    <FileText size={26} />
                  </div>
                  <div>
                    <h2>
                      {summary.pending
                        ? `${summary.pending} ${summary.pending === 1 ? "documento por revisar" : "documentos por revisar"}`
                        : "Un documento menos. Un poco más de orden."}
                    </h2>
                    <p>
                      {summary.pending
                        ? "Comprueba los datos extraídos antes de incorporarlos a tus cuentas."
                        : "Sube una foto o un PDF y revisa su información desde aquí."}
                    </p>
                  </div>
                  <Button
                    icon={summary.pending ? ArrowRight : Upload}
                    onClick={() =>
                      summary.pending
                        ? setPage("invoices")
                        : setEditor({ upload: true })
                    }
                  >
                    {summary.pending
                      ? "Revisar documentos"
                      : "Subir una factura"}
                  </Button>
                </section>
                <section>
                  <div className="section-label">
                    <h2>Últimos movimientos</h2>
                    <button
                      className="text-button"
                      onClick={() => setPage("invoices")}
                    >
                      Ver todos <ArrowRight size={16} />
                    </button>
                  </div>
                  <InvoiceTable
                    items={period.slice(0, 6)}
                    onEdit={setEditor}
                    onNew={() => setEditor({})}
                  />
                </section>
                <div className="footnote">
                  <ShieldCheck size={16} />
                  <p>
                    Solo los registros revisados actualizan tus estimaciones. Tú
                    decides qué entra en tus cuentas.
                  </p>
                </div>
              </>
            )}
          {["invoices", "pending"].includes(page) && unattached.length > 0 && (
            <UnattachedDocuments key={`unattached-${user.id}`} items={unattached} api={api} onOpen={d => setEditor({ document_id: d.id, reextract: true })} onDeleted={load} />
          )}
          {page === "pending" && <ReviewQueue items={invoices.filter((i) => i.status === "draft")} onEdit={setEditor} onNew={() => setEditor({})} onInvoices={() => setPage("invoices")} />}
          {page === "invoices" && <InvoiceChecks key={`invoice-checks-${user.id}`} api={api} scopedUrl={scopedUrl} items={invoices} online={online} onEdit={setEditor} onCorrected={load} />}
          {page === "invoices" && (
            <InvoiceList
              items={period}
              onEdit={setEditor}
              onNew={() => setEditor({})}
              year={year}
              quarter={quarter}
            />
          )}
          {page === "tax" &&
            summary &&
            summary.year === year &&
            summary.quarter === quarter && (
              <Tax
                summary={summary}
                user={user}
                year={year}
                quarter={quarter}
                reload={load}
                onSettings={() => setPage("settings")}
              />
            )}
          {page === "agency" && (
            <AgencyPanel
              spaces={spaces}
              refresh={refreshSpaces}
              onSelect={switchWorkspace}
              actor={actor || user}
              activeName={user.name}
              onDeactivate={deactivateAgency}
            />
          )}
          {page === "information" && (
            <>
              <AccountInformation user={user} />
              <InstallApp />
            </>
          )}
          {page === "settings" && (
            <>
              <Profile
                user={user}
                onSave={(profile) => {
                  if ((workspaceId || actor?.id) !== user.id) return;
                  setUser({ ...user, profile });
                  setNotice("Perfil actualizado.");
                }}
              />
              {!user.delegated && <PasswordForm />}
              {!user.delegated && (
                <DeleteAccountForm
                  onDelete={async (body) => {
                    const result = await api("/account", {
                      method: "DELETE",
                      body: JSON.stringify(body),
                    });
                    try {
                      await clearDrafts(user.id);
                    } catch {
                      window.alert(
                        "No se han podido borrar los borradores locales. Borra los datos de este sitio en el navegador.",
                      );
                    }
                    ++loadSequence.current;
                    csrf = "";
                    workspaceId = "";
                    setActor(null);
                    setSpaces({ clients: [], managers: [], agency: null });
                    setUser(null);
                    setInvoices([]);
                    setUnattached([]);
                    setSummary(null);
                    setQueue([]);
                    setEditor(null);
                    setPage("home");
                    window.alert(
                      result.documents_pending
                        ? "Tu cuenta se ha eliminado. Quedan archivos pendientes de eliminación física; contacta con el administrador. Las copias de seguridad caducan en 14 días."
                        : "Tu cuenta y sus documentos se han eliminado. Las copias de seguridad caducan en 14 días.",
                    );
                  }}
                />
              )}
            </>
          )}
        </div>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          {notice}
        </div>
      )}
      {editor && (
        <Editor
          initial={editor}
          user={user}
          onClose={() => { setEditor(null); if (navigator.onLine) load(); }}
          onSave={saved}
        />
      )}
    </div>
  );
}
function AccountMenu({ user, onNavigate, onLogout }) {
  const [open, setOpen] = useState(false);
  const container = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!container.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const navigate = (page) => {
    setOpen(false);
    onNavigate(page);
    trigger.current?.focus();
  };
  return (
    <div
      className="account-menu"
      ref={container}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        className="account-trigger"
        ref={trigger}
        aria-label="Opciones de mi cuenta"
        aria-expanded={open}
        aria-controls="account-options"
        onClick={() => setOpen(!open)}
      >
        <span className="avatar" aria-hidden="true">
          {user.name.slice(0, 1)}
        </span>
        <span className="account-name">{user.name}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="account-dropdown"
          id="account-options"
          role="group"
          aria-label="Opciones de mi cuenta"
        >
          <div className="account-identity">
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </div>
          <button onClick={() => navigate("settings")}>
            <Settings size={18} />
            Editar perfil
          </button>
          <button onClick={() => navigate("agency")}>
            <Files size={18} />
            Gestoría y accesos
          </button>
          <button onClick={() => navigate("information")}>
            <Info size={18} />
            Información
          </button>
          <div className="account-divider" />
          <button
            className="danger"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <LogOut size={18} />
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}
function AgencyPanel({ spaces, refresh, onSelect, actor, activeName, onDeactivate }) {
  const hasPortfolio = !!spaces.agency || !!spaces.memberships?.length;
  const [section, setSection] = useState(hasPortfolio ? "clients" : "connections");
  const [clientEmail, setClientEmail] = useState("");
  const [accessClient, setAccessClient] = useState(null);
  const [accessEmail, setAccessEmail] = useState("");
  const [clientInvitation, setClientInvitation] = useState(null);
  const [clientFilter, setClientFilter] = useState("active");
  const [editingClient, setEditingClient] = useState(null);
  const [editedName, setEditedName] = useState("");
  const [loading, setLoading] = useState(true);
  const [clientSearch, setClientSearch] = useState("");
  const [name, setName] = useState(spaces.agency || spaces.inactive_agency || ""),
    [client, setClient] = useState(""),
    [code, setCode] = useState(""),
    [invitation, setInvitation] = useState(""),
    [preview, setPreview] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState(null);
  useEffect(() => {
    refresh().catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  const run = async (task) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const labels = {
    "invoice.save": "Registro guardado",
    "review.submitted": "Documento enviado a gestoría",
    "review.approved": "Documento aprobado por gestoría",
    "review.changes_requested": "Cambios solicitados al cliente",
    "review.edited": "Documento corregido; revisión actualizada",
    "agency.deactivate": "Cuenta cambiada a autónomo",
    "team.invite": "Invitación de equipo creada",
    "team.invite_cancel": "Invitación de equipo anulada",
    "team.join": "Colaborador incorporado",
    "team.leave": "Colaborador salió del equipo",
    "team.remove": "Colaborador retirado del equipo",
    "team.assign": "Asignaciones del equipo actualizadas",
    "team.assigned": "Cliente asignado a un colaborador",
    "team.unassigned": "Asignación de cliente retirada",
    "document.upload": "Documento subido",
    "document.delete": "Documento eliminado",
    "document.ai_requested": "Lectura con IA solicitada",
    "invoice.check_requested": "Comprobación de original solicitada",
    "invoice.checked": "Registro contrastado con su original",
    "review.corrected_from_original": "Discrepancias corregidas desde el original",
    "document.ai_extracted": "Documento leído con IA",
    "profile.update": "Perfil fiscal actualizado",
    "client.create": "Cliente creado",
    "client.update": "Cliente actualizado",
    "template.save": "Datos recurrentes guardados",
    "template.delete": "Datos recurrentes eliminados",
    "adjustments.update": "Ajustes fiscales actualizados",
    "savings.update": "Reserva actualizada",
    "document.read": "Original consultado",
    "draft.delete": "Borrador eliminado",
    "invoice.delete": "Factura o gasto eliminado",
    export: "CSV descargado",
    "access.granted": "Acceso concedido",
    "access.revoked": "Acceso revocado",
  };
  const activeClients = spaces.clients.filter((c) => !c.archived);
  const pendingClients = activeClients.filter((c) => c.pending + c.unattached > 0);
  const archivedClients = spaces.clients.filter((c) => c.archived);
  const shownClients = spaces.clients.filter((c) =>
    (clientFilter === "archived" ? c.archived : !c.archived) &&
    (clientFilter !== "pending" || c.pending + c.unattached > 0) &&
    c.name.toLocaleLowerCase().includes(clientSearch.trim().toLocaleLowerCase())
  ).sort((a, b) => (b.pending + b.unattached) - (a.pending + a.unattached) || a.name.localeCompare(b.name, "es"));
  return (
    <div className="agency-layout" aria-busy={busy || loading}>
      <nav className="agency-sections" aria-label="Secciones de gestoría">
        {[...(hasPortfolio ? [["clients", "Cartera de clientes"]] : []), ["team", "Equipo"], ["connections", "Invitaciones y accesos"], ["settings", "Ajustes e historial"]].map(([value, label]) =>
          <button key={value} type="button" aria-pressed={section === value} onClick={() => setSection(value)}>{label}</button>
        )}
      </nav>
      {section === "team" && <TeamPanel spaces={spaces} refresh={refresh} onSelect={onSelect} actor={actor} />}
      {loading && <p role="status">Actualizando cartera de clientes…</p>}
      <ErrorBox message={error} />
      {notice && (
        <p role="status" className="banner">
          {notice}
        </p>
      )}
      <section className="settings-form" hidden={actor.account_scope === "agency_client" || (section !== "settings" && (hasPortfolio || section !== "connections"))}>
        <h2>
          {spaces.agency ? spaces.agency : "Activa tu espacio de gestoría"}
        </h2>
        <p>
          Gestiona varios clientes con registros y documentos separados. Las
          autorizaciones pertenecen a tu cuenta: {actor.email}.
        </p>
        {spaces.inactive_agency && <p className="banner">Tu cuenta es de autónomo. Al reactivar la gestoría recuperarás la cartera y los accesos que sigan autorizados por tus clientes.</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("/agency", {
                method: "PUT",
                body: JSON.stringify({ name }),
              });
              setSection("clients");
              setNotice("Espacio de gestoría actualizado.");
            });
          }}
        >
          <Field label="Nombre de la gestoría">
            <input
              required
              minLength={2}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button disabled={busy}>
            {spaces.agency ? "Actualizar nombre" : spaces.inactive_agency ? "Reactivar gestoría" : "Activar gestoría"}
          </Button>
        </form>
        {spaces.agency && <details className="agency-mode-change">
          <summary>Volver a cuenta de autónomo</summary>
          <p>Seguirás trabajando con tus propias facturas. Tus clientes y sus documentos se conservan, pero no podrás acceder a sus espacios hasta reactivar la gestoría. Se anularán los códigos de invitación pendientes.</p>
          <Button disabled={busy} onClick={() => run(onDeactivate)}>Cambiar a autónomo</Button>
        </details>}
      </section>
      {hasPortfolio && (
        <>
          <section className="settings-form agency-portfolio" hidden={section !== "clients"}>
            <div className="agency-portfolio-heading"><div><h2>{spaces.agency ? "Tu cartera de clientes" : "Clientes asignados"}</h2>
            <p>{activeClients.length} activos · {pendingClients.length} con tareas pendientes</p></div>
            <Button disabled={busy || loading} onClick={() => run(async () => {})}>Actualizar cartera</Button></div>
            <p>
              Los pendientes incluyen borradores y documentos todavía sin
              asociar. Abre un cliente para revisar sus facturas, perfil fiscal,
              estimaciones y carpeta trimestral.
            </p>
            <details className="agency-add-client" hidden={!spaces.agency}>
            <summary>Añadir cliente</summary>
            <p>Crea una cuenta de cliente con acceso vinculado a tu gestoría o <button type="button" className="text-button" onClick={() => setSection("connections")}>invita a alguien que ya tiene cuenta</button>.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const created = await api("/agency/clients", {
                    method: "POST",
                    body: JSON.stringify({ name: client, email: clientEmail }),
                  });
                  setClient("");
                  setClientEmail("");
                  setClientInvitation(created);
                  setClientFilter("active");
                  setClientSearch("");
                  setNotice("Cliente creado. Comparte su invitación para que active el acceso y pueda usar el chat.");
                });
              }}
            >
              <Field label="Nombre del nuevo cliente">
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  value={client}
                  onChange={(e) => setClient(e.target.value)}
                />
              </Field>
              <Field label="Correo del nuevo cliente"><input type="email" required value={clientEmail} onChange={e => setClientEmail(e.target.value)} /></Field>
              <Button disabled={busy}>Crear cliente e invitación</Button>
            </form>
            </details>
            <ClientInvitation invitation={clientInvitation} />
            <div className="agency-client-tools">
              <Field label="Buscar cliente"><input type="search" placeholder="Nombre del cliente" value={clientSearch} onChange={(e) => setClientSearch(e.target.value)} /></Field>
              <div className="agency-filters" role="group" aria-label="Filtrar clientes">
                {[["active", "Activos", activeClients.length], ["pending", "Con pendientes", pendingClients.length], ...(spaces.agency ? [["archived", "Archivados", archivedClients.length]] : [])].map(([value, label, count]) =>
                  <button key={value} type="button" aria-pressed={clientFilter === value} onClick={() => setClientFilter(value)}>{label} <span>{count}</span></button>
                )}
              </div>
            </div>
            <p className="agency-list-caption" role="status">{shownClients.length} clientes · Pendientes de todos los periodos, primero los que necesitan más revisión.</p>
            {!loading && !shownClients.length && <div className="agency-empty"><h3>{clientSearch ? "No encontramos ese cliente" : clientFilter === "pending" ? "No hay documentos pendientes" : clientFilter === "archived" ? "No hay clientes archivados" : spaces.agency ? "Añade tu primer cliente" : "Aún no tienes clientes asignados"}</h3><p>{clientSearch ? "Prueba con otro nombre o cambia el filtro." : clientFilter === "active" ? (spaces.agency ? "Crea un espacio para llevar sus cuentas o vincula una cuenta existente desde Invitaciones y accesos." : "La persona titular de la gestoría puede asignarte clientes desde Equipo. Después, actualiza la cartera.") : "Los clientes aparecerán aquí cuando tengan este estado."}</p></div>}
            <ul className="agency-clients">
              {shownClients
                .map((c) => (
                  <li key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      {workspaceId === c.id && <span className="agency-current">Espacio activo</span>}
                      <p>
                        {!c.can_manage ? `Asignado por ${c.agency_name}` : c.managed
                          ? (c.has_login ? "Cuenta de cliente activa" : "Acceso pendiente de activar")
                          : "Cuenta vinculada"}{" "}
                        ·{" "}
                        {c.archived
                          ? "Archivado"
                          : `${c.pending} por revisar · ${c.unattached} sin asociar`}
                      </p>
                    </div>
                    <div className="packet-actions">
                      {!c.archived && (
                        <Button aria-label={`Abrir ${c.name}`} disabled={busy} onClick={() => run(() => onSelect(c.id))}>
                          Abrir expediente
                        </Button>
                      )}
                      {!c.archived && c.pending + c.unattached > 0 && <Button className="primary" aria-label={`Revisar pendientes de ${c.name}`} disabled={busy} onClick={() => run(() => onSelect(c.id, "pending"))}>Revisar pendientes <ArrowRight size={16} /></Button>}
                      {!!c.can_manage && c.managed === 1 && !c.has_login && !c.archived && <Button disabled={busy} onClick={() => { setAccessClient(c.id); setAccessEmail(""); }}>Dar acceso al cliente</Button>}
                      {!!c.can_manage && c.managed === 1 && (
                        <Button disabled={busy} onClick={() => { setEditingClient(c.id); setEditedName(c.name); }}>Renombrar</Button>
                      )}
                      {!!c.can_manage && <Button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api(`/agency/clients/${c.id}`, {
                              method: "PUT",
                              body: JSON.stringify({ archived: !c.archived }),
                            });
                            if (!c.archived && workspaceId === c.id)
                              await onSelect("", "agency", "Cliente archivado. Sus documentos se conservan.");
                            setNotice(
                              c.archived
                                ? "Cliente reactivado."
                                : "Cliente archivado. Sus documentos se conservan.",
                            );
                          })
                        }
                      >
                        {c.archived ? "Reactivar" : "Archivar"}
                      </Button>}
                    </div>
                    {accessClient === c.id && <form className="agency-rename" onSubmit={e => { e.preventDefault(); run(async () => { const result = await api(`/agency/clients/${c.id}/activation`, {method:"POST", body:JSON.stringify({email:accessEmail})}); setClientInvitation(result); setAccessClient(null); setNotice("Invitación preparada. Comparte el enlace de activación con el cliente."); }); }}>
                      <Field label={`Correo de acceso de ${c.name}`}><input type="email" required value={accessEmail} onChange={e=>setAccessEmail(e.target.value)}/></Field>
                      <div className="packet-actions"><Button disabled={busy}>Preparar acceso</Button><Button type="button" onClick={()=>setAccessClient(null)}>Cancelar acceso</Button></div>
                    </form>}
                    {editingClient === c.id && <form className="agency-rename" onSubmit={(e) => {
                      e.preventDefault();
                      run(async () => {
                        await api(`/agency/clients/${c.id}`, {method: "PUT", body: JSON.stringify({name: editedName.trim(), archived: !!c.archived})});
                        setEditingClient(null);
                        if (workspaceId === c.id) await onSelect(c.id, "agency", "Nombre del cliente actualizado.");
                        setNotice("Nombre del cliente actualizado.");
                      });
                    }}>
                      <Field label="Nuevo nombre del cliente"><input autoFocus required minLength={2} maxLength={100} value={editedName} onChange={(e) => setEditedName(e.target.value)} /></Field>
                      <div className="packet-actions"><Button className="primary" disabled={busy || editedName.trim().length < 2}>Guardar nombre</Button><Button type="button" disabled={busy} onClick={() => setEditingClient(null)}>Cancelar</Button></div>
                    </form>}
                  </li>
                ))}
            </ul>
          </section>
          <section className="settings-form" hidden={!spaces.agency || section !== "connections"}>
            <h2>Invitar a una cuenta existente</h2>
            <p>
              Comparte el código con tu cliente. Desde su cuenta, podrá
              comprobar el nombre de la gestoría y autorizar el acceso. Caduca
              en 24 horas y sirve para una sola vinculación. Crear otro anula el
              anterior.
            </p>
            <div className="packet-actions">
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setInvitation(
                      (await api("/agency/invite", { method: "POST" })).code,
                    ),
                  )
                }
              >
                Generar código de invitación
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api("/agency/invite", { method: "DELETE" });
                    setInvitation("");
                    setNotice("Código anulado.");
                  })
                }
              >
                Anular código
              </Button>
            </div>
            {invitation && (
              <Field label="Código para compartir">
                <input
                  readOnly
                  value={invitation}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
            )}
          </section>
        </>
      )}
      <section className="settings-form" hidden={section !== "connections"}>
        <h2>Acceso de una gestoría a mi cuenta</h2>
        <p>
          Al autorizar, la gestoría y sus colaboradores asignados podrán consultar y modificar tus facturas, documentos,
          perfil fiscal y estimaciones, y descargar tus informes. No podrá
          cambiar tu contraseña ni eliminar tu cuenta. Puedes revocar el acceso
          aquí.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () =>
              setPreview(
                await api("/agency/connection", {
                  method: "POST",
                  body: JSON.stringify({ code }),
                }),
              ),
            );
          }}
        >
          <Field label="Código de tu gestoría">
            <input
              required
              minLength={20}
              maxLength={100}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          <Button disabled={busy}>Comprobar gestoría</Button>
        </form>
        {preview && (
          <div className="banner">
            <p>
              ¿Autorizar a <strong>{preview.name}</strong> a trabajar en tu
              cuenta personal?
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api("/agency/connection", {
                    method: "POST",
                    body: JSON.stringify({ code, accept: true }),
                  });
                  setPreview(null);
                  setCode("");
                  setNotice("Acceso autorizado.");
                })
              }
            >
              Autorizar acceso a mi cuenta
            </Button>
          </div>
        )}
        <ul className="agency-clients">
          {spaces.managers.map((m) => (
            <li key={m.id}>
              <div><strong>{m.name}</strong>{(!m.enabled || m.archived) && <p>Acceso suspendido. Puedes revocar la autorización.</p>}</div>
              <Button
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      actor.account_scope === "agency_client" ? `¿Salir de ${m.name}? Si no queda otra gestoría activa, perderás el acceso. El expediente se conserva.` : `¿Revocar el acceso de ${m.name}? Tus documentos se conservan.`,
                    )
                  )
                    run(async () => {
                      const result = await api(`/agency/connections/${m.id}`, {
                        method: "DELETE",
                      });
                      if (result.access_disabled) { window.dispatchEvent(new Event("session-ended")); return; }
                      setNotice("Acceso revocado.");
                    });
                }}
              >
                {actor.account_scope === "agency_client" ? "Salir de la gestoría" : "Revocar acceso"}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <section className="settings-form" hidden={section !== "settings"}>
        <h2>Historial de {activeName}</h2>
        <p>Últimas acciones realizadas en el espacio activo, con su autor y fecha.</p>
        <Button
          disabled={busy}
          onClick={() => run(async () => setHistory(await api("/activity")))}
        >
          Consultar últimas acciones
        </Button>
        {history && (
          <ul className="activity-list">
            {history.map((entry, index) => (
              <li key={index}>
                <strong>{entry.actor}</strong> ·{" "}
                {labels[entry.action] || entry.action}
                <small>
                  {new Date(entry.at * 1000).toLocaleString("es-ES")}
                </small>
              </li>
            ))}
            {!history.length && <li>No hay acciones registradas.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}

function TeamPanel({ spaces, refresh, onSelect, actor }) {
  const [team, setTeam] = useState(null);
  const [email, setEmail] = useState("");
  const [invitation, setInvitation] = useState(null);
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  const reloadTeam = async () => { if (spaces.agency) setTeam(await api("/team")); };
  useEffect(() => {
    let cancelled = false;
    if (spaces.agency) api("/team").then((data) => { if (!cancelled) setTeam(data); }).catch((e) => { if (!cancelled) setError(e.message); });
    else setTeam(null);
    return () => { cancelled = true; };
  }, [spaces.agency]);
  const run = async (task) => {
    setBusy(true); setError(""); setNotice("");
    try { await task(); await reloadTeam(); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const ownClients = spaces.owned_clients || [];
  return <div className="team-layout" aria-busy={busy}>
    <ErrorBox message={error} />
    {notice && <p className="banner" role="status">{notice}</p>}
    {spaces.agency && <section className="settings-form team-roster">
      <div className="agency-portfolio-heading"><div><h2>Equipo de {spaces.agency}</h2><p>{actor.name} · Administración y acceso a toda la cartera</p></div><Button disabled={busy} onClick={() => run(async () => {})}>Actualizar equipo</Button></div>
      <p>Los colaboradores pueden registrar, revisar, aprobar y descargar documentos de sus clientes asignados. Solo tú administras el equipo y las asignaciones. Tu actividad personal permanece privada.</p>
      <details className="team-invite">
        <summary>Invitar a un colaborador</summary>
        <p>Introduce el correo de su cuenta en Cuentas. Comparte el código por tu canal habitual; no se envía ningún correo. Caduca en 24 horas y solo sirve una vez.</p>
        <form onSubmit={(e) => { e.preventDefault(); run(async () => { setInvitation(await api("/team/invitations", {method: "POST", body: JSON.stringify({email})})); setEmail(""); }); }}>
          <Field label="Correo del colaborador"><input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button disabled={busy}>Generar invitación de equipo</Button>
        </form>
        {invitation && <div className="team-code"><p>Código para {invitation.email}. Se muestra solo ahora; generar otro para ese correo anula el anterior.</p><Field label="Código de invitación de equipo"><input readOnly value={invitation.code} onFocus={(e) => e.target.select()} /></Field></div>}
      </details>
      {!team && !error && <p role="status">Cargando equipo…</p>}
      {team && <>
        <h3>Colaboradores · {team.members.length}</h3>
        {!team.members.length && <p>Aún no hay colaboradores. Invita a alguien y, cuando acepte, asígnale sus clientes.</p>}
        <ul className="team-members">
          {team.members.map((member) => <li key={member.id}>
            <div className="team-member-heading"><div><strong>{member.name}</strong><p>{member.email}</p><small>Gestor · {member.client_ids.length} clientes asignados</small></div><div className="packet-actions">
              <Button disabled={busy} aria-label={`Asignar clientes a ${member.name}`} onClick={() => {setEditing(member.id); setSelected(member.client_ids); setSearch("");}}>Asignar clientes</Button>
              <Button disabled={busy} aria-label={`Retirar a ${member.name}`} onClick={() => { if (window.confirm(`¿Retirar a ${member.name} del equipo? Perderá el acceso a los clientes asignados de esta gestoría. Sus documentos se conservan.`)) run(async () => { await api(`/team/members/${member.id}`, {method: "DELETE"}); setEditing(null); setNotice("Colaborador retirado. Sus asignaciones se han eliminado."); }); }}>Retirar del equipo</Button>
            </div></div>
            {editing === member.id && <form className="team-assignments" onSubmit={(e) => {e.preventDefault(); run(async () => { await api(`/team/members/${member.id}/clients`, {method: "PUT", body: JSON.stringify({client_ids:selected})}); setEditing(null); setNotice("Asignaciones guardadas. Los permisos ya están actualizados."); });}}>
              <Field label="Buscar cliente para asignar"><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
              <fieldset><legend>Clientes de {member.name}</legend>
                {ownClients.filter((c) => c.id !== member.id && c.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((c) => <label key={c.id} className="team-client-option"><input type="checkbox" checked={selected.includes(c.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids,c.id] : ids.filter((id) => id !== c.id))} /><span>{c.name}{!!c.archived && <small>Archivado · acceso suspendido</small>}</span></label>)}
                {!ownClients.some((c) => c.id !== member.id && c.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <p>{search ? "No hay clientes con ese nombre." : "No hay clientes disponibles para asignar."}</p>}
              </fieldset>
              <p>{selected.length} seleccionados. Desmarcar un cliente retira su acceso; no elimina sus documentos. Los archivados solo serán accesibles al reactivarlos.</p>
              <div className="packet-actions"><Button className="primary" disabled={busy}>Guardar asignaciones</Button><Button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancelar</Button></div>
            </form>}
          </li>)}
        </ul>
        {team.invitations.length > 0 && <details className="team-pending"><summary>Invitaciones pendientes · {team.invitations.length}</summary><ul className="team-members">{team.invitations.map((invite) => <li key={invite.id}><div className="team-member-heading"><div><strong>{invite.email}</strong><p>Caduca el {new Date(invite.expires * 1000).toLocaleString("es-ES")}</p></div><Button disabled={busy} aria-label={`Anular invitación de ${invite.email}`} onClick={() => run(async () => {await api(`/team/invitations/${invite.id}`, {method:"DELETE"}); if (invitation?.id === invite.id) setInvitation(null); setNotice("Invitación anulada.");})}>Anular invitación</Button></div></li>)}</ul></details>}
      </>}
    </section>}
    <section className="settings-form">
      <h2>Mis equipos</h2>
      <p>Únete como colaborador con el código que te haya compartido la gestoría. Debes usar el correo al que va dirigida la invitación: {actor.email}.</p>
      <form onSubmit={(e) => {e.preventDefault(); run(async () => setPreview(await api("/team/join", {method:"POST", body: JSON.stringify({code})})));}}>
        <Field label="Código para unirme al equipo"><input required minLength={20} maxLength={100} value={code} onChange={(e) => {setCode(e.target.value); setPreview(null);}} /></Field>
        <Button disabled={busy}>Comprobar invitación de equipo</Button>
      </form>
      {preview && <div className="team-join-preview"><h3>{preview.name}</h3><p>Entrarás como gestor. Solo podrás trabajar con los clientes que te asignen. Unirte no comparte tus propias facturas con la gestoría.</p><Button disabled={busy} className="primary" onClick={() => run(async () => {await api("/team/join", {method:"POST", body:JSON.stringify({code,accept:true})}); setCode(""); setPreview(null); setNotice("Te has unido al equipo. La gestoría ya puede asignarte clientes.");})}>Aceptar y unirme al equipo</Button></div>}
      <ul className="team-members">{(spaces.memberships || []).map((membership) => <li key={membership.id}><div className="team-member-heading"><div><strong>{membership.name}</strong><p>{membership.enabled ? "Gestor · acceso a clientes asignados" : "Gestoría desactivada · acceso suspendido"}</p></div><Button disabled={busy} aria-label={`Salir de ${membership.name}`} onClick={() => {if(window.confirm(`¿Salir de ${membership.name}? Perderás el acceso a sus clientes asignados.`)) run(async () => {await api(`/team/memberships/${membership.id}`, {method:"DELETE"}); if(workspaceId) await onSelect("", "agency", "Has salido del equipo y vuelto a tu actividad."); setNotice("Has salido del equipo. Tus datos personales se conservan.");});}}>Salir del equipo</Button></div></li>)}</ul>
    </section>
  </div>;
}

function InstallApp() {
  const [prompt, setPrompt] = useState(window.cuentasInstallPrompt || null);
  const [installed, setInstalled] = useState(
    window.matchMedia("(display-mode: standalone)").matches ||
      navigator.standalone,
  );
  useEffect(() => {
    const ready = () => setPrompt(window.cuentasInstallPrompt);
    const done = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("cuentas-install-ready", ready);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("cuentas-install-ready", ready);
      window.removeEventListener("appinstalled", done);
    };
  }, []);
  return (
    <section className="settings-form">
      <h2>Cuentas en tu móvil</h2>
      {installed ? (
        <p>La app está abierta en modo instalado.</p>
      ) : (
        <>
          {prompt && (
            <Button
              onClick={async () => {
                await prompt.prompt();
                await prompt.userChoice;
                window.cuentasInstallPrompt = null;
                setPrompt(null);
              }}
            >
              Instalar Cuentas
            </Button>
          )}
          <p>
            En iPhone: abre esta web en Safari → Compartir → Añadir a la
            pantalla de inicio. En Android: menú del navegador → Instalar
            aplicación o Añadir a la pantalla de inicio.
          </p>
        </>
      )}
      <p>
        Puedes preparar borradores sin conexión mientras mantengas la app
        abierta. Para iniciar sesión, subir fotos, leer documentos o descargar
        el trimestre necesitas internet.
      </p>
    </section>
  );
}
function AccountInformation({ user }) {
  return (
    <section className="settings-form account-information">
      <h2>Tu espacio en Cuentas</h2>
      <dl>
        <div>
          <dt>Nombre</dt>
          <dd>{user.name}</dd>
        </div>
        <div>
          <dt>Identificador de acceso</dt>
          <dd>{user.email}</dd>
        </div>
        <div>
          <dt>Versión</dt>
          <dd>0.1.0</dd>
        </div>
      </dl>
      <h3>Documentos y privacidad</h3>
      <p>
        Tus documentos están separados de los de otras cuentas. La lectura de
        fotos y PDF incluye lectura automática con OpenAI al subir o abrir un documento. El resultado se guarda para evitar lecturas repetidas; si falla, se ofrece lectura local y revisión manual.
      </p>
      <h3>Estimaciones fiscales</h3>
      <p>
        Los resúmenes son orientativos y solo incluyen registros revisados.
        Cuentas no presenta declaraciones a Hacienda. Confirma tu régimen en
        «Editar perfil» antes de utilizar las estimaciones.
      </p>
      <h3>Acceso a tu cuenta</h3>
      <p>
        Puedes cambiar tu contraseña desde «Editar perfil». Si pierdes el
        acceso, contacta con el administrador del servidor.
      </p>
    </section>
  );
}

function SavingsTracker({ summary, year, quarter, reload, online }) {
  const [amount, setAmount] = useState(decimal(summary.saved_amount));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    setAmount(decimal(summary.saved_amount));
  }, [summary.saved_amount]);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await api(`/savings/${year}/${quarter}`, {
        method: "PUT",
        body: JSON.stringify({ amount: cents(amount) }),
      });
      await reload();
      setSaved(true);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="savings-tracker" aria-label="Tu reserva para impuestos">
      <div className="savings-heading">
        <h2>Tu reserva para impuestos</h2>
        <p>
          Indica el total que ya has apartado para T{quarter} de {year}. Este
          registro no mueve dinero ni modifica tus impuestos.
        </p>
      </div>
      <div className="savings-layout">
        <form onSubmit={submit}>
          <Field label="Ya he apartado (€)">
            <input
              type="number"
              min="0"
              max="10000000"
              step="0.01"
              required
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setSaved(false);
              }}
            />
          </Field>
          <Button type="submit" disabled={busy || !online}>
            {busy ? "Guardando…" : "Actualizar reserva"}
          </Button>
        </form>
        <dl>
          <div>
            <dt>Guardado</dt>
            <dd>{money(summary.saved_amount)}</dd>
          </div>
          <div>
            <dt>
              {summary.reserve_complete
                ? "Te falta apartar"
                : "Pendiente de calcular"}
            </dt>
            <dd>
              {summary.remaining_to_save === null
                ? "—"
                : money(summary.remaining_to_save)}
            </dd>
          </div>
        </dl>
      </div>
      {!summary.adjustments_reviewed && (
        <p className="reserve-note">
          Revisa retenciones, pagos anteriores y ajustes en Resumen fiscal para
          afinar el objetivo.
        </p>
      )}
      {!summary.reserve_complete && (
        <p className="reserve-note">
          Completa el perfil fiscal para calcular el objetivo total. Tu ahorro
          queda guardado igualmente.
        </p>
      )}
      <ErrorBox message={error} />
      {saved && (
        <p className="save-status" role="status">
          Reserva actualizada.
        </p>
      )}
    </section>
  );
}

function Login({ onLogin, online }) {
  const initialClientCode = new URLSearchParams(window.location.hash.slice(1)).get("activar-cliente") || "";
  const [activatingClient, setActivatingClient] = useState(!!initialClientCode);
  const [accountType, setAccountType] = useState("personal");
  const [registering, setRegistering] = useState(
      new URLSearchParams(window.location.search).get("registro") === "1",
    ),
    [name, setName] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (registering && password !== confirmation) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onLogin(
        await api(registering ? "/register" : "/login", {
          method: "POST",
          body: JSON.stringify(
            registering
              ? { name, email, password, account_type: accountType }
              : { email, password },
          ),
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (activatingClient) return <ClientActivationForm api={api} onLogin={onLogin} initialCode={initialClientCode} onCancel={() => { history.replaceState(null,"",location.pathname); setActivatingClient(false); }} />;
  return (
    <main className="login">
      <section className="login-story">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          Cuentas
        </div>
        <div>
          <h1>
            Menos papeles.
            <br />
            Más claridad.
          </h1>
          <p>
            Facturas, gastos y tu trimestre en un mismo lugar. Un espacio propio
            para llevar tu actividad al día.
          </p>
          <div className="login-rule" />
          <span>Tu actividad. Tus documentos. Tu servidor.</span>
        </div>
        <small>Gestión para autónomos · Salamanca</small>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <h2>{registering ? "Crea tu cuenta" : "Entra en tus cuentas"}</h2>
          <p>
            {registering
              ? "Empieza con un espacio propio para tus facturas y gastos."
              : "Accede a tu espacio personal."}
          </p>
          {registering && (
            <Field label="Tu nombre">
              <input
                required
                minLength="2"
                maxLength="100"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          )}
          {registering && (
            <Field label="Tipo de cuenta">
              <select
                value={accountType}
                onChange={(e) => setAccountType(e.target.value)}
              >
                <option value="personal">Autónomo · mi actividad</option>
                <option value="agency">Gestoría · varios clientes</option>
              </select>
            </Field>
          )}
          <Field label="Correo electrónico">
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Contraseña">
            <input
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              minLength={registering ? 12 : undefined}
              maxLength="256"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {registering && (
            <>
              <small className="password-hint">
                Usa una contraseña de al menos 12 caracteres.
              </small>
              <Field label="Repite la contraseña">
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </Field>
            </>
          )}
          <ErrorBox message={error} />
          {!online && (
            <p className="banner">Necesitas conexión para iniciar sesión.</p>
          )}
          <Button
            className="primary"
            disabled={busy || !online}
            icon={busy ? LoaderCircle : ArrowRight}
          >
            {busy
              ? registering
                ? "Creando cuenta…"
                : "Entrando…"
              : registering
                ? "Crear cuenta"
                : "Entrar"}
          </Button>
          <div className="auth-switch">
            <span>
              {registering ? "¿Ya tienes cuenta?" : "¿Aún no tienes cuenta?"}
            </span>
            <button
              type="button"
              className={
                registering ? "text-button" : "button secondary register-button"
              }
              disabled={busy}
              onClick={() => {
                setRegistering(!registering);
                setError("");
                setPassword("");
                setConfirmation("");
              }}
            >
              {registering ? "Iniciar sesión" : "Crear una cuenta"}
            </button>
          </div>
          <button className="text-button" type="button" onClick={() => setActivatingClient(true)}>Activar acceso de cliente</button>
          <p className="login-help">
            {registering
              ? "Tus registros estarán separados de los de otras cuentas. El correo se utiliza para identificar tu acceso; no se envía un mensaje de verificación."
              : "Si necesitas recuperar el acceso, contacta con el administrador del servidor."}
          </p>
        </form>
      </section>
    </main>
  );
}
const reviewLabels = { submitted: "Enviada a gestoría", changes_requested: "Cambios solicitados", approved: "Aprobada por gestoría" };
const reviewActions = { submitted: "Enviado a gestoría", changes_requested: "Cambios solicitados", approved: "Aprobado y contabilizado", edited: "Datos modificados", corrected_from_original: "Discrepancias corregidas desde el original" };
function ReviewQueue({ items, onEdit, onNew, onInvoices }) {
  const [filter, setFilter] = useState("all");
  const shown = items.filter((i) => filter === "all" || (i.review_state || "draft") === filter);
  return <section className="review-queue">
    <div className="agency-review-heading"><div><h2>Cola de revisión</h2><p>Los documentos pendientes no se incluyen en los cálculos fiscales.</p></div><Button onClick={onInvoices}>Ver facturas del trimestre</Button></div>
    <div className="agency-filters" role="group" aria-label="Estado de revisión">
      {[["all", "Todos"], ["submitted", "Enviados"], ["changes_requested", "Con cambios"], ["draft", "Borradores"]].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{items.filter((i) => value === "all" || (i.review_state || "draft") === value).length}</span></button>)}
    </div>
    {shown.length ? <InvoiceTable items={shown} onEdit={onEdit} onNew={onNew} /> : <p className="review-empty" role="status">No hay documentos en este estado.</p>}
  </section>;
}
function InvoiceTable({ items, onEdit, onNew }) {
  if (!items.length)
    return (
      <div className="empty">
        <FileText size={32} />
        <h3>Aquí empieza tu registro</h3>
        <p>
          Añade tu primera factura o gasto. Aparecerá aquí para que puedas
          revisarlo.
        </p>
        <Button onClick={onNew} icon={Plus}>
          Añadir un documento
        </Button>
      </div>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Documento / tercero</th>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Estado</th>
            <th className="numeric">Total</th>
            <th>
              <span className="sr-only">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>
                <button className="row-link" onClick={() => onEdit(i)}>
                  {i.party || "Tercero por completar"}
                </button>
                <small>
                  {i.number || "Sin número"} · {i.category}
                </small>
              </td>
              <td>
                {new Date(i.date + "T12:00:00").toLocaleDateString("es-ES")}
              </td>
              <td>
                <span className={"type " + i.kind}>
                  {i.kind === "income" ? "Ingreso" : "Gasto"}
                </span>
              </td>
              <td>
                <span className={"status " + i.status}>
                  {reviewLabels[i.review_state] || (i.status === "draft" ? "Por revisar" : "Revisado")}
                </span>
              </td>
              <td className="numeric">
                <strong>{money(i.total)}</strong>
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`Editar ${i.number || "documento"}`}
                  onClick={() => onEdit(i)}
                >
                  <ChevronRight size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function QuarterPacket({ year, quarter }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const download = async (format) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        scopedUrl(
          `/api/quarter-packet?year=${year}&quarter=${quarter}&format=${format}`,
        ),
      );
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail || "No se pudo descargar el trimestre.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `cuentas-${year}-T${quarter}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="quarter-packet">
      <div>
        <h3>
          Tu carpeta para el gestor · T{quarter} {year}
        </h3>
        <p>
          PDF único con fichas, notas y originales de todos los registros del
          trimestre, incluidos los borradores. El ZIP añade originales y datos
          completos. No incluye documentos sin asociar ni borradores sin
          sincronizar.
        </p>
      </div>
      <div className="packet-actions">
        <Button
          disabled={busy || !navigator.onLine}
          icon={Printer}
          onClick={() => download("pdf")}
        >
          {busy ? "Preparando…" : "PDF para imprimir"}
        </Button>
        <Button
          disabled={busy || !navigator.onLine}
          icon={Download}
          onClick={() => download("zip")}
        >
          Descargar carpeta ZIP
        </Button>
      </div>
      <ErrorBox message={error} />
    </section>
  );
}
function InvoiceList({ items, onEdit, onNew, year, quarter }) {
  const [filter, setFilter] = useState("all"),
    [search, setSearch] = useState("");
  const shown = items.filter(
    (i) =>
      (filter === "all" || i.kind === filter || i.status === filter || i.review_state === filter) &&
      `${i.party} ${i.number} ${i.nif}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <section>
      <ReportSharing key={`${workspaceId}-${year}-${quarter}`} api={api} scopedUrl={scopedUrl} year={year} quarter={quarter} />
      <QuarterPacket year={year} quarter={quarter} />
      <div className="list-tools">
        <div className="tabs" aria-label="Filtrar documentos">
          {[
            ["all", "Todos"],
            ["income", "Ingresos"],
            ["expense", "Gastos"],
            ["draft", "Por revisar"],
            ["submitted", "Enviados"],
            ["changes_requested", "Con cambios"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={filter === value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <a
          className="button"
          href={scopedUrl(`/api/export?year=${year}&quarter=${quarter}`)}
        >
          <Download size={16} /> Exportar CSV
        </a>
      </div>
      <label className="search">
        <Search size={18} />
        <input
          aria-label="Buscar facturas"
          placeholder="Buscar por tercero, número o NIF…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {items.length && !shown.length ? (
        <div className="empty">
          <h3>No hay coincidencias</h3>
          <p>Prueba con otra búsqueda o cambia el filtro.</p>
        </div>
      ) : (
        <InvoiceTable items={shown} onEdit={onEdit} onNew={onNew} />
      )}
    </section>
  );
}
function Profile({ user, onSave }) {
  const [profile, setProfile] = useState({
      regime: "unknown",
      vat_regime: "unknown",
      irpf_required: "unknown",
      previous_net: null,
      previous_net_year: new Date().getFullYear() - 1,
      ...user.profile,
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [priorText, setPriorText] = useState(
    profile.previous_net === null ? "" : decimal(profile.previous_net),
  );
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      onSave(
        await api("/profile", {
          method: "PUT",
          body: JSON.stringify({
            ...profile,
            previous_net: priorText === "" ? null : cents(priorText),
            previous_net_year: Number(profile.previous_net_year),
          }),
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="settings-form" onSubmit={submit}>
      <h2>Cómo tributa tu actividad</h2>
      <p>
        Indica cómo estás dado de alta en Hacienda. Estas opciones sirven para
        calcular tus previsiones; guardarlas aquí no cambia tu alta fiscal.
      </p>
      <FiscalHelp topic="start" />
      <Field label="Régimen de IRPF">
        <select
          aria-describedby="fiscal-irpf-hint"
          value={profile.regime}
          onChange={(e) => setProfile({ ...profile, regime: e.target.value })}
        >
          <option value="unknown">Pendiente de confirmar</option>
          <option value="direct_normal">Estimación directa normal</option>
          <option value="direct_simplified">
            Estimación directa simplificada
          </option>
          <option value="modules">Estimación objetiva (módulos)</option>
        </select>
      </Field>
      <FiscalHelp topic="irpf" value={profile.regime} />
      <Field label="Régimen de IVA">
        <select
          aria-describedby="fiscal-vat-hint"
          value={profile.vat_regime}
          onChange={(e) =>
            setProfile({ ...profile, vat_regime: e.target.value })
          }
        >
          <option value="unknown">Pendiente de confirmar</option>
          <option value="general">
            Régimen general · operaciones nacionales ordinarias
          </option>
          <option value="special">Régimen especial / otras operaciones</option>
        </select>
      </Field>
      <FiscalHelp topic="vat" value={profile.vat_regime} />
      <Field
        label="Obligación de presentar Modelo 130"
      >
        <select
          aria-describedby="fiscal-model130-hint"
          value={profile.irpf_required}
          onChange={(e) =>
            setProfile({ ...profile, irpf_required: e.target.value })
          }
        >
          <option value="unknown">Pendiente de confirmar</option>
          <option value="yes">Sí, confirmada</option>
          <option value="no">No, exoneración confirmada</option>
        </select>
      </Field>
      <FiscalHelp topic="model130" value={profile.irpf_required} />
      <h3 className="profile-subheading">Rendimiento del año anterior · opcional</h3>
      <p className="profile-explanation">Es el rendimiento neto fiscal de tus actividades, no lo facturado ni el saldo de tu cuenta. Puedes consultarlo en la Renta del ejercicio indicado. Ayuda a calcular una posible minoración del pago fraccionado.</p>
      <Field label="Ejercicio del rendimiento anterior">
        <input
          type="number"
          min="1999"
          max="2099"
          required
          value={profile.previous_net_year}
          onChange={(e) =>
            setProfile({ ...profile, previous_net_year: e.target.value })
          }
        />
      </Field>
      <Field
        label="Rendimiento neto de ese ejercicio (€)"
        hint={`Déjalo vacío si no lo conoces: no equivale a cero. Este dato solo se usará para la minoración de ${Number(profile.previous_net_year) + 1}.` }
      >
        <input
          type="number"
          step="0.01"
          value={priorText}
          onChange={(e) => setPriorText(e.target.value)}
        />
      </Field>
      <FiscalReadiness profile={profile} />
      <ErrorBox message={error} />
      <Button className="primary" disabled={busy} icon={Check}>
        {busy ? "Guardando…" : "Guardar perfil"}
      </Button>
    </form>
  );
}
function DeleteAccountForm({ onDelete }) {
  const [expanded, setExpanded] = useState(false),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onDelete({ current_password: password, confirmation });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <section className="settings-form password-form delete-account">
      <h2>Eliminar mi cuenta</h2>
      <p>
        Se borrarán tu perfil, facturas, documentos y ahorros registrados. Esta
        acción no se puede deshacer.
      </p>
      {!expanded ? (
        <Button
          type="button"
          className="danger"
          onClick={() => setExpanded(true)}
        >
          Eliminar mi cuenta
        </Button>
      ) : (
        <form onSubmit={submit}>
          <p>
            Descarga antes los documentos que necesites conservar. También se
            borrarán los borradores sin sincronizar de este dispositivo. Las
            copias de seguridad cifradas caducan en un máximo de 14 días.
          </p>
          <Field label="Contraseña para eliminar la cuenta">
            <input
              autoFocus
              required
              type="password"
              autoComplete="current-password"
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Escribe ELIMINAR para confirmar">
            <input
              required
              pattern="ELIMINAR"
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </Field>
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setExpanded(false);
                setPassword("");
                setConfirmation("");
                setError("");
              }}
            >
              Cancelar
            </Button>
            <Button
              className="danger"
              disabled={busy || confirmation !== "ELIMINAR" || !password}
            >
              {busy ? "Eliminando…" : "Eliminar cuenta definitivamente"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState(""),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setDone(false);
    if (next !== confirm) {
      setError("Las contraseñas nuevas no coinciden.");
      return;
    }
    setBusy(true);
    try {
      await api("/password", {
        method: "PUT",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="settings-form password-form" onSubmit={submit}>
      <h2>Contraseña de acceso</h2>
      <p>Al cambiarla se cierran las otras sesiones de tu cuenta.</p>
      <Field label="Contraseña actual">
        <input
          required
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="Nueva contraseña" hint="Mínimo 12 caracteres.">
        <input
          required
          minLength="12"
          maxLength="256"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Field label="Repite la nueva contraseña">
        <input
          required
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <ErrorBox message={error} />
      {done && <p role="status">Contraseña actualizada.</p>}
      <Button disabled={busy} className="primary">
        Cambiar contraseña
      </Button>
    </form>
  );
}
function Tax({ summary: s, user, year, quarter, reload, onSettings }) {
  const asText = (values) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, decimal(value)]),
    );
  const [values, setValues] = useState(asText(s.adjustments)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => setValues(asText(s.adjustments)), [s]);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/adjustments/${year}/${quarter}`, {
        method: "PUT",
        body: JSON.stringify(
          Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, cents(value)]),
          ),
        ),
      });
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const irpf = s.supported && s.irpf_required === "yes";
  return (
    <>
      <p className="banner">
        Estimación orientativa. Revisa los registros y ajustes con tu gestoría
        antes de presentar. Esta app no envía declaraciones a Hacienda.
      </p>
      <div className="tax-columns">
        <section className="tax-sheet">
          <h2>IVA · Modelo 303</h2>
          <p>Operaciones del {quarter}.º trimestre</p>
          <dl>
            <div>
              <dt>IVA repercutido</dt>
              <dd>{money(s.output_vat)}</dd>
            </div>
            <div>
              <dt>IVA soportado deducible</dt>
              <dd>− {money(s.input_vat)}</dd>
            </div>
            <div>
              <dt>Saldo registrado</dt>
              <dd>{money(s.vat_balance)}</dd>
            </div>
            <div>
              <dt>Compensación indicada</dt>
              <dd>− {money(s.vat_credit_applied)}</dd>
            </div>
            <div className="total">
              <dt>Resultado orientativo</dt>
              <dd>
                {user.profile.vat_regime === "general"
                  ? money(s.vat_estimate)
                  : "Sin configurar"}
              </dd>
            </div>
          </dl>
          <small>
            Un saldo negativo no solicita automáticamente devolución. No incluye
            operaciones especiales. Compensación previa sin aplicar:{" "}
            {money(s.vat_credit_remaining)}.
          </small>
        </section>
        <section className="tax-sheet">
          <h2>IRPF · Modelo 130</h2>
          <p>Acumulado desde el 1 de enero</p>
          <dl>
            <div>
              <dt>Ingresos computados</dt>
              <dd>{money(s.income)}</dd>
            </div>
            <div>
              <dt>Gastos deducibles registrados</dt>
              <dd>− {money(s.expenses)}</dd>
            </div>
            <div>
              <dt>Otros gastos / amortización</dt>
              <dd>− {money(s.adjustments.extra_expenses)}</dd>
            </div>
            {s.difficult_expenses_rate > 0 && (
              <div>
                <dt>Difícil justificación · {s.difficult_expenses_rate} % (máx. 2.000 €/año)</dt>
                <dd>− {money(s.difficult_expenses)}</dd>
              </div>
            )}
            <div>
              <dt>Retenciones soportadas</dt>
              <dd>− {money(s.withheld)}</dd>
            </div>
            {irpf && (
              <>
                <div>
                  <dt>20 % del rendimiento positivo</dt>
                  <dd>{money(s.box04)}</dd>
                </div>
                <div>
                  <dt>Casilla 05</dt>
                  <dd>− {money(s.box05)}</dd>
                </div>
                <div>
                  <dt>Minoración</dt>
                  <dd>− {money(s.reduction)}</dd>
                </div>
                <div>
                  <dt>Negativos anteriores aplicados</dt>
                  <dd>− {money(s.box15)}</dd>
                </div>
              </>
            )}
            <div className="total">
              <dt>Resultado orientativo</dt>
              <dd>
                {irpf
                  ? money(s.irpf_estimate)
                  : s.irpf_required === "no"
                    ? "Exoneración indicada"
                    : "Por revisar"}
              </dd>
            </div>
          </dl>
          {!irpf && (
            <button className="text-button" onClick={onSettings}>
              Revisar perfil fiscal <ArrowRight size={16} />
            </button>
          )}
        </section>
      </div>
      <form className="adjustments" onSubmit={save}>
        <h2>Ajustes del periodo</h2>
        <p>
          {s.adjustments_reviewed
            ? "Hay ajustes guardados para este periodo."
            : "Aún no has revisado los ajustes de este periodo."}{" "}
          No se arrastran automáticamente de declaraciones anteriores.
        </p>
        <div className="form-grid">
          {[
            [
              "box05",
              "Casilla 05 del Modelo 130 (€)",
              "Suma de casillas 07 positivas anteriores menos casillas 16; no es simplemente lo pagado.",
            ],
            [
              "negative_prior",
              "Negativos anteriores pendientes (€)",
              "Importe disponible para casilla 15, antes de limitarlo al resultado positivo.",
            ],
            [
              "extra_expenses",
              "Otros gastos deducibles acumulados (€)",
              "Amortizaciones y ajustes no incluidos ya en los registros. En simplificada, no añadas aquí los gastos de difícil justificación: se calculan automáticamente.",
            ],
            [
              "vat_credit",
              "IVA a compensar que aplicas (€)",
              "Introduce solo la compensación procedente que deseas aplicar.",
            ],
          ].map(([key, label, hint]) => (
            <Field key={key} label={label} hint={hint}>
              <input
                type="number"
                step="0.01"
                min="0"
                value={values[key]}
                onChange={(e) =>
                  setValues({ ...values, [key]: e.target.value })
                }
              />
            </Field>
          ))}
        </div>
        <ErrorBox message={error} />
        <Button disabled={busy} className="primary">
          {busy ? "Guardando…" : "Guardar ajustes revisados"}
        </Button>
      </form>
      <details className="assumptions">
        <summary>Alcance y fuentes del cálculo</summary>
        <ul>
          {s.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <a
          href="https://sede.agenciatributaria.gob.es/Sede/impuestos-tasas/impuesto-sobre-renta-personas-fisicas/modelo-130-irpf______esionales-estimacion-directa-fraccionado_/instrucciones.html"
          target="_blank"
          rel="noreferrer"
        >
          Consultar instrucciones oficiales del Modelo 130
        </a>
      </details>
    </>
  );
}
function Editor({ initial, user, onClose, onSave }) {
  const dialog = useRef(null),
    fileInput = useRef(null),
    cameraInput = useRef(null);
  const [form, setForm] = useState({
    kind: initial.kind || "expense",
    status: initial.status || "draft",
    date: initial.date || today(),
    number: initial.number || "",
    party: initial.party || "",
    nif: initial.nif || "",
    category: initial.category || "Otros",
    withholding: decimal(initial.withholding || 0),
    note: initial.note || "",
    document_id: initial.document_id || null,
    request_id: initial.request_id || crypto.randomUUID(),
    version: initial.version || 1,
    lines: (
      initial.lines || [
        {
          base: 0,
          vat_rate: 21,
          irpf_deduct: 100,
          vat_deduct: 100,
          description: "",
        },
      ]
    ).map((l) => ({ ...l, base: decimal(l.base) })),
  });
  const protectedFields = useRef(new Set(
    Object.keys(documentFieldLabels).filter(key => initial[key] !== undefined && initial[key] !== ""),
  ));
  const [aiConfig, setAiConfig] = useState(null);
  const [analysisNotice, setAnalysisNotice] = useState("");
  useEffect(() => {
    if (navigator.onLine) api("/document-analysis").then(setAiConfig).catch(() => {});
  }, []);
  const applyReading = (result) => {
    setDocument(previous => ({ ...previous, ...result }));
    setForm(current => ({
      ...mergeDocumentSuggestions(current, result, protectedFields.current),
      document_id: result.id,
    }));
    setDirty(true);
    setChecked(false);
    setAnalysisNotice(result.ai_error ? "Lectura local disponible. La lectura automática con IA no se ha completado." : "Lectura terminada. Se han rellenado los datos reconocidos y conservado tus cambios manuales.");
  };
  const [document, setDocument] = useState(null),
    [preview, setPreview] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [checked, setChecked] = useState(false),
    [dirty, setDirty] = useState(false);
  const [policy, setPolicy] = useState(null);
  const [reviewHistory, setReviewHistory] = useState([]);
  const [reviewComment, setReviewComment] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const sendToAgency = policy?.required && !policy?.can_approve;
  useEffect(() => {
    if (!navigator.onLine) return;
    let cancelled = false;
    Promise.all([api("/review-policy"), initial.id ? api(`/invoices/${initial.id}/reviews`) : Promise.resolve([])])
      .then(([nextPolicy, history]) => { if (!cancelled) { setPolicy(nextPolicy); setReviewHistory(history); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);
  const returnForChanges = async () => {
    setError("");
    setBusy(true);
    try {
      await api(`/invoices/${initial.id}/request-changes`, {method: "POST", body: JSON.stringify({version: form.version, comment: reviewComment.trim()})});
      await onSave("Cambios solicitados. El cliente verá el comentario al abrir su cuenta.");
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const [templates, setTemplates] = useState([]),
    [selectedTemplate, setSelectedTemplate] = useState(""),
    [templateName, setTemplateName] = useState(""),
    [templateNotice, setTemplateNotice] = useState("");
  useEffect(() => {
    api("/templates")
      .then(setTemplates)
      .catch((e) => setError(e.message));
  }, []);
  const applyTemplate = (id) => {
    setSelectedTemplate(id);
    setTemplateNotice("");
    const item = templates.find((t) => t.id === id);
    if (!item) {
      setTemplateName("");
      return;
    }
    setTemplateName(item.label);
    for (const key of ["party", "nif", ...(item.kind === "expense" ? ["lines", "withholding"] : [])]) protectedFields.current.add(key);
    setForm((f) => ({
      ...f,
      party: item.party,
      nif: item.nif,
      ...(item.kind === "expense"
        ? {
            category: item.category,
            lines: item.lines.map((l) => ({ ...l, base: decimal(l.base) })),
            withholding: decimal(item.withholding),
            note: item.note,
          }
        : {}),
    }));
    setChecked(false);
    setDirty(true);
    setTemplateNotice(
      "Datos habituales rellenados. Comprueba el importe, la fecha y el número de esta factura.",
    );
  };
  const saveTemplate = async () => {
    setBusy(true);
    setError("");
    setTemplateNotice("");
    try {
      if (!templateName.trim() || !form.party.trim())
        throw new Error(
          "Indica un nombre para guardar y el cliente o proveedor.",
        );
      const expense = form.kind === "expense";
      const body = {
        kind: expense ? "expense" : "client",
        label: templateName.trim(),
        party: form.party,
        nif: form.nif,
        ...(expense
          ? {
              category: form.category,
              lines: form.lines.map((l) => ({ ...l, base: cents(l.base) })),
              withholding: cents(form.withholding),
              note: form.note,
            }
          : {}),
      };
      const saved = await api(
        "/templates" + (selectedTemplate ? "/" + selectedTemplate : ""),
        {
          method: selectedTemplate ? "PUT" : "POST",
          body: JSON.stringify(body),
        },
      );
      setTemplates(await api("/templates"));
      setSelectedTemplate(saved.id);
      setTemplateNotice(
        expense
          ? "Gasto recurrente guardado para próximas facturas."
          : "Cliente guardado para próximos ingresos.",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const removeTemplate = async () => {
    if (
      !window.confirm(
        "¿Eliminar estos datos guardados? Los registros anteriores se conservan.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api("/templates/" + selectedTemplate, { method: "DELETE" });
      setTemplates(await api("/templates"));
      setSelectedTemplate("");
      setTemplateName("");
      setTemplateNotice("Datos guardados eliminados.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const change = (key, value) => {
    protectedFields.current.add(key);
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    setChecked(false);
  };
  const close = () => {
    if (
      !dirty ||
      window.confirm("Tienes cambios sin guardar. ¿Cerrar la revisión?")
    )
      onClose();
  };
  useEffect(() => {
    dialog.current.showModal();
    return () => {
      dialog.current?.close();
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  useEffect(() => {
    if (!initial.document_id) return;
    setBusy(true);
    setAnalysisNotice("Leyendo el documento con IA…");
    api("/documents/" + initial.document_id + "/prepare?kind=" + form.kind, {method: "POST"})
      .then(applyReading)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);
  const readWithAI = async () => {
    setBusy(true);
    setError("");
    setAnalysisNotice("Leyendo el documento con IA…");
    try {
      applyReading(await api(`/documents/${form.document_id}/ai-extraction?kind=${form.kind}`, {method: "POST"}));
    } catch (e) {
      setError(e.message);
      setAnalysisNotice("No se ha completado la lectura con IA. Tus datos se conservan.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initial.document_id)
      fetch(scopedUrl("/api/documents/" + initial.document_id))
        .then((r) => {
          if (!r.ok) throw new Error("No se pudo abrir el documento.");
          return r.blob();
        })
        .then((blob) => {
          setPreview(URL.createObjectURL(blob));
          setDocument((d) => ({ ...d, mime: blob.type }));
        })
        .catch((e) => setError(e.message));
  }, []);
  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    if (file.size > 12 * 1024 * 1024) {
      setError("El archivo supera 12 MB.");
      return;
    }
    setBusy(true);
    setAnalysisNotice("Leyendo el documento con IA…");
    try {
      const body = new FormData();
      body.append("file", file);
      const result = await api("/documents?kind=" + form.kind, { method: "POST", body });
      applyReading(result);
      setPreview(URL.createObjectURL(file));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };
  const lineChange = (index, key, value) =>
    change(
      "lines",
      form.lines.map((l, i) => (i === index ? { ...l, [key]: value } : l)),
    );
  const totals = form.lines.reduce(
    (t, l) => {
      const base = Number(l.base || 0) * 100;
      return {
        base: t.base + base,
        vat: t.vat + Math.round((base * l.vat_rate) / 100),
      };
    },
    { base: 0, vat: 0 },
  );
  const save = async (status) => {
    setError("");
    setBusy(true);
    try {
      const payload = {
        ...form,
        status: status === "submit" ? "draft" : status,
        review_action: status === "submit" ? "submit" : "save",
        withholding: cents(form.withholding),
        lines: form.lines.map((l) => ({ ...l, base: cents(l.base) })),
      };
      if (status === "confirmed" && !checked)
        throw new Error(
          "Comprueba los datos y marca la confirmación de revisión.",
        );
      if (!navigator.onLine) {
        if (user.delegated)
          throw new Error(
            "Para trabajar en una cuenta de cliente necesitas conexión.",
          );
        if (initial.id || payload.document_id)
          throw new Error(
            "Para editar registros o guardar documentos cargados necesitas conexión.",
          );
        await saveDraft(user.id, { ...payload, status: "draft" });
        await onSave(
          "Borrador guardado en este dispositivo. Sincronízalo al recuperar la conexión.",
        );
        return;
      }
      await api("/invoices" + (initial.id ? "/" + initial.id : ""), {
        method: initial.id ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      await onSave(
        status === "submit"
          ? "Documento enviado a gestoría. Pendiente de aprobación."
          : status === "confirmed"
          ? user.delegated ? `Documento aprobado en el expediente de ${user.name}.` : "Documento revisado. Tus cuentas están actualizadas."
          : "Borrador guardado. Puedes revisarlo más tarde.",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !window.confirm(
        "¿Eliminar este registro guardado? Se retirará de los cálculos fiscales y se perderán los cambios sin guardar. El documento original se conserva.",
      )
    )
      return;
    setBusy(true);
    try {
      await api(`/invoices/${initial.id}?version=${initial.version}`, { method: "DELETE" });
      await onSave("Registro eliminado. Los cálculos se han actualizado.");
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="editor"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-labelledby="editor-title"
    >
      <header className="editor-header">
        <div>
          <h2 id="editor-title">
            {initial.id ? "Revisar documento" : "Añadir un documento"}
            {user.delegated ? ` · ${user.name}` : ""}
          </h2>
          <p>
            {form.document_id
              ? "Comprueba el original y completa los datos."
              : "Sube tu factura o introduce los datos manualmente."}
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Cerrar revisión"
          disabled={busy}
          onClick={close}
        >
          <X />
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(sendToAgency ? "submit" : "confirmed");
        }}
      >
        <div className="editor-columns">
          <aside className="document-panel">
            <input
              ref={cameraInput}
              className="sr-only"
              aria-label="Capturar foto de factura"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={upload}
              disabled={busy || !!form.document_id}
            />
            {!form.document_id && (
              <Button
                type="button"
                icon={Camera}
                className="primary camera-button"
                disabled={busy || !navigator.onLine}
                onClick={() => cameraInput.current.click()}
              >
                Hacer foto
              </Button>
            )}
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={upload}
              disabled={busy || !!form.document_id}
            />
            {preview ? (
              <>
                <div className="preview-title">
                  <FileText size={17} />
                  <strong>{document?.name || "Documento original"}</strong>
                </div>
                {document?.mime === "application/pdf" ? (
                  <iframe title="Factura original" src={preview} />
                ) : (
                  <img
                    className="document-image"
                    src={preview}
                    alt="Factura original para revisar"
                  />
                )}
              </>
            ) : (
              <button
                type="button"
                className="upload-zone"
                disabled={busy || !navigator.onLine}
                onClick={() => fileInput.current.click()}
              >
                <Upload size={32} />
                <strong>
                  {busy ? "Leyendo el documento…" : "Selecciona una factura"}
                </strong>
                <span>Foto o PDF · hasta 12 MB · 8 páginas</span>
                <small>Se leerá automáticamente con OpenAI para rellenar los datos.</small>
              </button>
            )}
            {busy && (
              <p className="working" role="status">
                <LoaderCircle size={18} className="spin" /> Procesando…
              </p>
            )}
            {form.document_id && <div className="ai-reading">
              <p>Lectura automática con IA. El documento se envía a OpenAI; comprueba los datos antes de guardar.</p>
              {document?.ai_error && <Button type="button" disabled={busy || !navigator.onLine || !aiConfig?.available} onClick={readWithAI}>Reintentar lectura con IA</Button>}
            </div>}
            {document?.classification && <div className="document-classification" role="status">
              <strong>{{invoice: "Factura", receipt: "Recibo", other: "Otro documento", unknown: "Documento sin identificar"}[document.classification.document_type]}</strong>
              <span>País del emisor: {document.classification.issuer_country ? new Intl.DisplayNames(['es'], {type: 'region'}).of(document.classification.issuer_country) : "No identificado"}</span>
              <p>{document.classification.evidence}</p>
            </div>}
            {document?.fields?.detected_total !== undefined && (
              <p className="banner" role="status">
                Total del documento: {money(document.fields.detected_total)}.{" "}
                {Math.abs(totals.base + totals.vat - cents(form.withholding || "0") - document.fields.detected_total) <= 2
                  ? "Coincide con el formulario."
                  : `Diferencia con el formulario: ${money(totals.base + totals.vat - cents(form.withholding || "0") - document.fields.detected_total)}. Revisa los importes.`}
              </p>
            )}
            {!!document?.warnings?.length && (
              <div className="banner"><strong>Revisa estos datos</strong><ul>{document.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>
            )}
            {document?.warning && <p className="banner">{document.warning}</p>}
            {document?.text && (
              <details className="ocr-text">
                <summary>Texto de la lectura local · revisar</summary>
                <pre>{document.text}</pre>
              </details>
            )}
            <p className="document-note">
              La lectura automática propone los campos que reconoce. Comprueba
              importes, tipos de IVA, deducibilidad y el papel de cada tercero
              en el original.
            </p>
          </aside>
          <div className="document-form">
            <fieldset className="kind-picker">
              <legend>Tipo de registro</legend>
              {[
                ["expense", "Gasto"],
                ["income", "Ingreso"],
              ].map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="kind"
                    value={value}
                    checked={form.kind === value}
                    disabled={busy}
                    onChange={() => {
                      setForm(current => {
                        const next = {...current, kind: value};
                        if (document?.parties) {
                          for (const key of ["party", "nif"]) {
                            if (!protectedFields.current.has(key)) next[key] = document.parties[value]?.[key] || "";
                          }
                        }
                        return next;
                      });
                      setDirty(true);
                      setChecked(false);
                      setSelectedTemplate("");
                      setTemplateName("");
                      setTemplateNotice("");
                    }}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="analysis-status" role="status" aria-live="polite">{analysisNotice}</div>
            {document?.fields && ["date", "number", "party", "nif", "lines"].some(key => documentSuggestions(document, form.kind)[key] === undefined) && (
              <p className="document-missing">No se ha podido leer: {["date", "number", "party", "nif", "lines"].filter(key => documentSuggestions(document, form.kind)[key] === undefined).map(key => documentFieldLabels[key]).join(", ")}. Comprueba estos campos en el original.</p>
            )}
            {document?.fields && (
              <details className="extraction-review">
                <summary>Datos detectados · {document.engine}</summary>
                <p>Los campos que has editado se conservan. Puedes aplicar una propuesta concreta aquí.</p>
                <dl>
                  {Object.entries(documentSuggestions(document, form.kind)).map(([key, value]) => (
                    <div key={key}>
                      <dt>{documentFieldLabels[key]}</dt>
                      <dd>
                        <span>{key === "lines" ? value.map(line => `${money(cents(line.base))} · IVA ${line.vat_rate}%`).join(" / ") : key === "withholding" ? money(cents(value)) : value}</span>
                        {document.evidence?.[key]?.method === "calculated" && <small>Calculado a partir del porcentaje leído.</small>}
                        <Button type="button" disabled={busy} onClick={() => change(key, value)} aria-label={`Aplicar propuesta: ${documentFieldLabels[key]}`}>Aplicar</Button>
                      </dd>
                    </div>
                  ))}
                </dl>
                {Object.keys(documentSuggestions(document, form.kind)).length === 0 && <p>No se han reconocido campos. Prueba la lectura con IA o completa los datos manualmente.</p>}
                <p>Comprueba también los porcentajes de deducibilidad antes de confirmar.</p>
              </details>
            )}
            <details className="recurring-tools">
              <summary>
                {form.kind === "expense"
                  ? "Gastos recurrentes y suscripciones"
                  : "Clientes guardados"}
              </summary>
              <Field
                label={
                  form.kind === "expense"
                    ? "Rellenar desde un gasto recurrente"
                    : "Rellenar desde un cliente"
                }
              >
                <select
                  value={selectedTemplate}
                  onChange={(e) => applyTemplate(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Selecciona o guarda uno nuevo</option>
                  {templates
                    .filter(
                      (t) =>
                        t.kind ===
                        (form.kind === "expense" ? "expense" : "client"),
                    )
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                </select>
              </Field>
              <p>
                {form.kind === "expense"
                  ? "Guarda proveedor, conceptos, importes y notas habituales. Cada uso requiere revisar y registrar la nueva factura."
                  : "Guarda nombre y NIF para rellenarlos en tus próximos ingresos."}
              </p>
              <Field label="Nombre para guardar">
                <input
                  value={templateName}
                  maxLength={100}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder={
                    form.kind === "expense"
                      ? "Por ejemplo, suscripción mensual"
                      : "Por ejemplo, cliente habitual"
                  }
                />
              </Field>
              <div className="packet-actions">
                <Button
                  type="button"
                  disabled={busy || !navigator.onLine}
                  onClick={saveTemplate}
                >
                  {selectedTemplate
                    ? "Actualizar datos guardados"
                    : form.kind === "expense"
                      ? "Guardar gasto recurrente"
                      : "Guardar cliente"}
                </Button>
                {selectedTemplate && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={removeTemplate}
                  >
                    Eliminar datos guardados
                  </Button>
                )}
              </div>
              {templateNotice && <p role="status">{templateNotice}</p>}
            </details>
            <div className="form-grid">
              <Field label="Número de factura">
                <input
                  required
                  maxLength="100"
                  value={form.number}
                  onChange={(e) => change("number", e.target.value)}
                />
              </Field>
              <Field label="Fecha">
                <input
                  required
                  type="date"
                  value={form.date}
                  onChange={(e) => change("date", e.target.value)}
                />
              </Field>
              <Field label={form.kind === "expense" ? "Proveedor" : "Cliente"}>
                <input
                  required
                  maxLength="200"
                  value={form.party}
                  onChange={(e) => change("party", e.target.value)}
                />
              </Field>
              <Field label="NIF del tercero">
                <input
                  required
                  maxLength="30"
                  value={form.nif}
                  onChange={(e) => change("nif", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Categoría">
              <select
                value={form.category}
                onChange={(e) => change("category", e.target.value)}
              >
                {[
                  "Otros",
                  "Servicios profesionales",
                  "Material",
                  "Software",
                  "Suministros",
                  "Transporte",
                  "Cuotas",
                  "Alquiler",
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            <div className="section-label">
              <h3>Desglose de importes</h3>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  change("lines", [
                    ...form.lines,
                    {
                      description: "",
                      base: "0.00",
                      vat_rate: 21,
                      irpf_deduct: 100,
                      vat_deduct: 100,
                    },
                  ])
                }
              >
                <Plus size={16} /> Añadir base
              </button>
            </div>
            {form.lines.map((line, index) => (
              <fieldset className="invoice-line" key={index}>
                <legend>Base {index + 1}</legend>
                <Field label={`Concepto de la base ${index + 1}`}>
                  <input
                    maxLength={300}
                    value={line.description || ""}
                    onChange={(e) =>
                      lineChange(index, "description", e.target.value)
                    }
                    placeholder="Por ejemplo, suscripción de software"
                  />
                </Field>
                <div className="form-grid">
                  <Field label="Base imponible (€)">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={line.base}
                      onChange={(e) =>
                        lineChange(index, "base", e.target.value)
                      }
                    />
                  </Field>
                  <Field label="Tipo de IVA">
                    <select
                      value={line.vat_rate}
                      onChange={(e) =>
                        lineChange(index, "vat_rate", Number(e.target.value))
                      }
                    >
                      {[0, 4, 10, 21].map((rate) => (
                        <option value={rate} key={rate}>
                          {rate} %
                        </option>
                      ))}
                    </select>
                  </Field>
                  {form.kind === "expense" && (
                    <>
                      <Field label="Deducible IRPF (%)">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          required
                          value={line.irpf_deduct}
                          onChange={(e) =>
                            lineChange(
                              index,
                              "irpf_deduct",
                              Number(e.target.value),
                            )
                          }
                        />
                      </Field>
                      <Field label="Deducible IVA (%)">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          required
                          value={line.vat_deduct}
                          onChange={(e) =>
                            lineChange(
                              index,
                              "vat_deduct",
                              Number(e.target.value),
                            )
                          }
                        />
                      </Field>
                    </>
                  )}
                </div>
                {form.lines.length > 1 && (
                  <button
                    type="button"
                    className="text-button danger"
                    onClick={() =>
                      change(
                        "lines",
                        form.lines.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 size={15} /> Quitar esta base
                  </button>
                )}
              </fieldset>
            ))}
            <Field
              label="Retención IRPF (€)"
              hint={
                form.kind === "expense"
                  ? "Retención practicada al proveedor; no se resta de tu Modelo 130."
                  : "Retención soportada en este ingreso."
              }
            >
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={form.withholding}
                onChange={(e) => change("withholding", e.target.value)}
              />
            </Field>
            <dl className="invoice-total">
              <div>
                <dt>Base + IVA − retención</dt>
                <dd>
                  {money(
                    totals.base +
                      totals.vat -
                      Number(form.withholding || 0) * 100,
                  )}
                </dd>
              </div>
            </dl>
            <Field label="Notas">
              <textarea
                rows="2"
                maxLength="2000"
                value={form.note}
                onChange={(e) => change("note", e.target.value)}
              />
            </Field>
            <section className="document-review" aria-label="Revisión de gestoría">
              {sendToAgency && <p>Tu gestoría debe aprobar este documento antes de contabilizarlo. Puedes guardar un borrador o enviarlo a revisión.</p>}
              {initial.review_state === "changes_requested" && <div className="review-feedback"><h3>Cambios solicitados</h3><p>{initial.review_note}</p></div>}
              {initial.status === "confirmed" && <p>Guardar como borrador retira este registro de los cálculos. Los cambios necesitarán una nueva revisión.</p>}
              {reviewHistory.length > 0 && <details className="review-history"><summary>Historial de revisión ({reviewHistory.length})</summary><ol>{reviewHistory.map((entry, index) => <li key={index}><strong>{reviewActions[entry.action] || entry.action}</strong><small>{entry.actor_name} · {new Date(entry.at * 1000).toLocaleString("es-ES")} · Versión {entry.version}</small>{entry.comment && <p>{entry.comment}</p>}</li>)}</ol></details>}
              {policy?.can_approve && initial.review_state === "submitted" && <div className="request-changes">
                <Button type="button" disabled={busy} onClick={() => setReturnOpen(!returnOpen)} aria-expanded={returnOpen}>Pedir cambios al cliente</Button>
                {returnOpen && <div><Field label="Qué debe corregir el cliente"><textarea rows="3" maxLength={2000} value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} /></Field>{dirty && <p>Hay cambios sin guardar. Guarda el documento como borrador o cierra y vuelve a abrir la revisión para devolver la versión original.</p>}<Button type="button" disabled={busy || dirty || !reviewComment.trim()} onClick={returnForChanges}>Enviar solicitud de cambios</Button></div>}
              </div>}
            </section>
            {!sendToAgency && <label className="review-check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              He comprobado el original, los importes y su deducibilidad.
            </label>}
            <ErrorBox message={error} />
          </div>
        </div>
        <footer className="editor-footer">
          {initial.id && (
            <Button
              type="button"
              className="danger"
              disabled={busy}
              icon={Trash2}
              onClick={remove}
            >
              {initial.status === "draft" ? "Eliminar borrador" : initial.kind === "expense" ? "Eliminar gasto" : "Eliminar factura"}
            </Button>
          )}
          <span className="spacer" />
          <Button type="button" disabled={busy} onClick={() => save("draft")}>
            Guardar borrador
          </Button>
          <Button
            className="primary"
            type="submit"
            disabled={busy || !policy || (!sendToAgency && !checked) || !navigator.onLine}
            icon={Check}
          >
            {sendToAgency ? "Enviar a gestoría" : policy?.can_approve ? "Aprobar y contabilizar" : "Confirmar y registrar"}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  window.cuentasInstallPrompt = event;
  window.dispatchEvent(new Event("cuentas-install-ready"));
});
createRoot(document.getElementById("root")).render(<App />);
if ("serviceWorker" in navigator && import.meta.env.PROD)
  window.addEventListener("load", () =>
    navigator.serviceWorker
      .register("/sw.js?v=19", { updateViaCache: "none" })
      .catch(() => {}),
  );
