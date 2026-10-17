import React, { useEffect, useRef, useState } from "react";

const months = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const money = value => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value / 100);
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const series = {
  activity: [["income", "Ingresos", "income"], ["expenses", "Gastos", "expenses"]],
  profit: [["profit", "Beneficio antes de impuestos", "profit"]],
  taxes: [["tax_paid", "Impuestos pagados registrados", "taxes"]],
};

function AnnualChart({ rows, year, quarter }) {
  const [view, setView] = useState("activity");
  const [selected, setSelected] = useState(quarter * 3 - 1);
  useEffect(() => setSelected(quarter * 3 - 1), [quarter, year]);
  const keys = series[view];
  const values = rows.flatMap(row => keys.map(([key]) => row[key]));
  const high = Math.max(100, ...values);
  const low = Math.min(0, ...values);
  const y = value => 200 - (value - low) / (high - low) * 174;
  const x = index => 76 + index * 45;
  const row = rows[selected];
  const hasRecords = rows.some(row => view === "taxes" ? row.payments_recorded : row.count > 0);
  return <section className="annual-chart" aria-labelledby="evolution-title">
    <div className="chart-heading"><h2 id="evolution-title">Tu año, mes a mes</h2><span>{year}</span></div>
    <div className="chart-tabs" role="group" aria-label="Datos de la gráfica">
      {[["activity", "Ingresos y gastos"], ["profit", "Beneficio"], ["taxes", "Impuestos"]].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}
    </div>
    <div className="chart-legend">{keys.map(([key, label, color]) => <span key={key}><i className={`chart-key ${color}`} />{label}</span>)}</div>
    {!hasRecords && <p className="chart-empty">{view === "taxes" ? "Aún no has registrado pagos de impuestos este año." : "Tu evolución aparecerá al confirmar documentos de este año."}</p>}
    <svg className="annual-plot" viewBox="0 0 620 242" role="img" aria-label={`${view === "activity" ? "Ingresos y gastos" : view === "profit" ? "Beneficio antes de impuestos" : "Pagos de impuestos registrados"} por mes de ${year}. Importes exactos en el detalle y en la tabla inferior.`}>
      {[low, (high + low) / 2, high].map((value, index) => <g key={index}>
        <line x1="55" x2="606" y1={y(value)} y2={y(value)} className="chart-grid" />
        <text x="49" y={y(value) + 4} textAnchor="end">{new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 }).format(value / 100)} €</text>
      </g>)}
      {low < 0 && <line x1="55" x2="606" y1={y(0)} y2={y(0)} className="chart-zero" />}
      <rect x={x(selected) - 20} y="18" width="40" height="191" className="chart-selection" />
      {view === "profit" && <polyline points={rows.map((r, i) => `${x(i)},${y(r.profit)}`).join(" ")} className="profit-line" />}
      {rows.map((r, i) => <g key={r.month}>
        {keys.map(([key, , color], k) => view === "profit"
          ? <circle key={key} cx={x(i)} cy={y(r[key])} r="3.5" className="profit-dot" />
          : <rect key={key} x={x(i) + (keys.length === 2 ? k * 14 - 13 : -8)} y={Math.min(y(0), y(r[key]))} width={keys.length === 2 ? 11 : 16} height={Math.abs(y(r[key]) - y(0))} rx="2" className={`chart-bar ${color}`} />)}
        <text x={x(i)} y="229" textAnchor="middle">{months[i].slice(0, 3)}</text>
      </g>)}
    </svg>
    <div className="chart-months" role="group" aria-label="Consultar un mes">
      {months.map((month, i) => <button key={month} type="button" aria-label={`${month} de ${year}`} aria-pressed={selected === i} onClick={() => setSelected(i)}>{month.slice(0, 3)}</button>)}
    </div>
    <div className="month-detail" aria-live="polite">
      <strong>{months[selected]}</strong>
      {keys.map(([key, label]) => <span key={key}>{label}<b>{view === "taxes" && !row.payments_recorded ? "Sin registrar" : money(row[key])}</b></span>)}
    </div>
    <p className="chart-explanation">{view === "taxes" ? "Solo pagos que has registrado; los meses sin registrar no confirman ausencia de pagos." : "Meses sin documentos revisados: 0 €. La gráfica muestra registros, no previsiones."}</p>
    <details className="chart-table"><summary>Ver todos los importes del año</summary>
      <div className="table-scroll"><table><caption>Registros de {year} · importes en euros</caption><thead><tr><th>Mes</th><th>Ingresos</th><th>Gastos</th><th>Beneficio</th><th>Impuestos pagados</th></tr></thead><tbody>
        {rows.map((r, i) => <tr key={r.month}><th scope="row">{months[i]}</th>{["income", "expenses", "profit"].map(key => <td key={key}>{money(r[key])}</td>)}<td>{r.payments_recorded ? money(r.tax_paid) : "Sin registrar"}</td></tr>)}
      </tbody></table></div>
    </details>
  </section>;
}

function Payments({ rows, year, quarter, api, reload, online, disclosure }) {
  const [month, setMonth] = useState(quarter * 3);
  const [values, setValues] = useState({ vat: "", irpf: "", other: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const row = rows[month - 1];
    setValues(Object.fromEntries(["vat", "irpf", "other"].map(key => [key, row.payments_recorded ? (row[`${key}_paid`] / 100).toFixed(2) : ""])));
    setError("");
  }, [month, rows]);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const body = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(Number(value) * 100)]));
      await api(`/tax-payments/${year}/${month}`, { method: "PUT", body: JSON.stringify(body) });
      await reload();
      setNotice(`Pagos de ${months[month - 1].toLowerCase()} guardados.`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <details className="payment-ledger" ref={disclosure}>
    <summary>Registrar o corregir impuestos pagados</summary>
    <p>Indica el total que has pagado en cada mes, según tus justificantes. Guardar sustituye los importes de ese mes. Usa 0 si no has pagado un concepto.</p>
    <form onSubmit={save}>
      <fieldset disabled={busy}><legend className="sr-only">Pagos de impuestos de {year}</legend>
        <label className="field"><span>Mes del pago · {year}</span><select value={month} onChange={e => { setMonth(Number(e.target.value)); setNotice(""); }}>{months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
        <div className="payment-fields">{[["vat", "IVA pagado (€)"], ["irpf", "IRPF pagado (€)"], ["other", "Otros impuestos pagados (€)"]].map(([key, label]) => <label key={key} className="field"><span>{label}</span><input required type="number" inputMode="decimal" min="0" max="10000000" step="0.01" value={values[key]} onChange={e => setValues({ ...values, [key]: e.target.value })} /></label>)}</div>
        <p className="payment-help">Incluye los ingresos directos a Hacienda. Las retenciones de tus facturas y la cuota de autónomos quedan fuera de este registro. Un pago de enero cuenta en enero, aunque corresponda al trimestre anterior. No modifica las estimaciones ni la reserva.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="button primary" disabled={!online}>{busy ? "Guardando…" : "Guardar pagos del mes"}</button>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
    </form>
  </details>;
}

export default function FinancialDashboard({ summary, year, quarter, api, reload, online, children }) {
  const [scope, setScope] = useState("quarter");
  const disclosure = useRef(null);
  const rows = summary.months;
  const selected = scope === "year" ? rows : rows.slice((quarter - 1) * 3, quarter * 3);
  const paidMonths = selected.filter(r => r.payments_recorded).length;
  function openPayments() { disclosure.current.open = true; disclosure.current.scrollIntoView({ behavior: "instant", block: "center" }); disclosure.current.querySelector("select").focus(); }
  return <>
    <section className="financial-summary" aria-label="Resumen económico">
      <div className="financial-heading"><h2>{scope === "year" ? `Resumen de ${year}` : `${quarter}.º trimestre de ${year}`}</h2><div className="chart-tabs" role="group" aria-label="Periodo del resumen"><button type="button" aria-pressed={scope === "quarter"} onClick={() => setScope("quarter")}>Trimestre</button><button type="button" aria-pressed={scope === "year"} onClick={() => setScope("year")}>Año completo</button></div></div>
      <dl className="financial-metrics">
        <div><dt>Ingresos brutos</dt><dd>{money(sum(selected, "income"))}</dd><small>Facturado sin IVA, antes de gastos</small></div>
        <div><dt>Gastos</dt><dd>{money(sum(selected, "expenses"))}</dd><small>Bases de todos los gastos revisados</small></div>
        <div className="profit-metric"><dt>Beneficio antes de impuestos</dt><dd>{money(sum(selected, "profit"))}</dd><small>Ingresos − gastos, sin IVA</small></div>
        <div><dt>Impuestos pagados</dt><dd>{paidMonths ? money(sum(selected, "tax_paid")) : "Sin registrar"}</dd><small>{paidMonths ? `${paidMonths} de ${selected.length} meses registrados` : "Añade los pagos de tus justificantes"}</small><button type="button" className="text-button" onClick={openPayments}>Registrar pagos</button></div>
      </dl>
      <p className="financial-note">Solo documentos revisados, por fecha de factura. El beneficio no incluye ajustes fiscales ni mide el saldo del banco. Los impuestos pagados son la suma de IVA, IRPF y otros pagos que registres.</p>
    </section>
    <div className="overview financial-overview"><AnnualChart rows={rows} year={year} quarter={quarter} />{children}</div>
    <Payments key={`${year}-${quarter}`} rows={rows} year={year} quarter={quarter} api={api} reload={reload} online={online} disclosure={disclosure} />
  </>;
}
