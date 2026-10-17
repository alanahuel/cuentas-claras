import React, { useEffect, useRef, useState } from 'react';

const labels = { matched: 'Sin diferencias detectadas', differences: 'Diferencias detectadas', incomplete: 'Lectura incompleta · revisar', no_document: 'Sin original asociado', outdated: 'Registro modificado · comprobar de nuevo', unchecked: 'Pendiente de comprobar', error: 'No se pudo comprobar' };
const money = value => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value / 100);
function display(value, field) {
  if (field === 'lines') return value.map(line => `${money(line.base)} de base · IVA ${line.vat_rate} %: ${money(line.vat)}`).join('; ');
  if (['detected_total', 'withholding'].includes(field)) return money(value);
  if (field === 'date') return value.split('-').reverse().join('/');
  return String(value || 'Sin indicar');
}

export default function InvoiceChecks({ api, items, online, onEdit, scopedUrl, onCorrected }) {
  const [results, setResults] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionErrors, setCorrectionErrors] = useState({});
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);
  const stopped = useRef(false);
  const running = useRef(false);
  const active = useRef(true);
  const sequence = useRef(0);
  const signature = items.map(i => `${i.id}:${i.version}`).join(',');
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; stopped.current = true; ++sequence.current; };
  }, []);
  useEffect(() => {
    const id = ++sequence.current;
    setLoading(true);
    api('/invoice-checks').then(rows => {
      if (active.current && id === sequence.current) setResults(Object.fromEntries(rows.map(r => [r.invoice_id, r])));
    }).catch(e => { if (active.current && id === sequence.current) setError(e.message); })
      .finally(() => { if (active.current && id === sequence.current) setLoading(false); });
  }, [api, signature]);
  const run = async (selected = items, reread = false) => {
    if (running.current) return;
    running.current = true; stopped.current = false; ++sequence.current;
    setBusy(true); setLoading(false); setError('');
    let completed = 0;
    try {
      for (const item of selected) {
        if (stopped.current || !active.current) break;
        setProgress(`Comprobando ${completed + 1} de ${selected.length} · ${item.number || item.date}`);
        try {
          const result = await api(`/invoices/${item.id}/check${reread ? '?reread=true' : ''}`, { method: 'POST' });
          if (!active.current) break;
          setResults(previous => ({ ...previous, [item.id]: result }));
          completed++;
        } catch (e) {
          if (!active.current) break;
          setResults(previous => ({ ...previous, [item.id]: { invoice_id: item.id, version: item.version, status: 'error', message: e.message } }));
          if (!e.status || [401, 403, 429, 502, 503].includes(e.status)) { setError(e.message); break; }
          completed++;
        }
      }
    } finally {
      running.current = false;
      if (active.current) {
        setBusy(false);
        setProgress(`${completed} de ${selected.length} registros procesados.`);
        if (selected === items) setExpanded(false);
      }
    }
  };
  const correct = async (selected) => {
    if (running.current) return;
    running.current = true; stopped.current = false; ++sequence.current;
    setBusy(true); setCorrecting(true); setError(''); setCorrectionErrors({});
    let completed = 0, failed = 0;
    try {
      for (const { item, result } of selected) {
        if (stopped.current || !active.current) break;
        setProgress(`Corrigiendo ${completed + failed + 1} de ${selected.length} · ${item.number || item.date}`);
        try {
          const response = await api(`/invoices/${item.id}/apply-check`, { method: 'POST', body: JSON.stringify({ version: item.version, check_id: result.check_id }) });
          completed++;
          if (!active.current) break;
          setResults(previous => ({ ...previous, [item.id]: response.check }));
        } catch (e) {
          failed++;
          if (!active.current) break;
          setCorrectionErrors(previous => ({ ...previous, [item.id]: e.message }));
          if (!e.status || [401, 403, 429, 502, 503].includes(e.status)) { setError(e.message); break; }
        }
      }
    } finally {
      if (active.current) {
        await onCorrected();
        if (active.current) {
          setBusy(false); setCorrecting(false);
          setProgress(`${completed} registros corregidos · ${selected.length - completed} sin corregir en esta ejecución. Los impuestos se han actualizado.`);
        }
      }
      running.current = false;
    }
  };
  const rows = items.map(item => {
    const stored = results[item.id];
    const result = stored && stored.version !== item.version ? { ...stored, status: 'outdated' } : stored || { status: 'unchecked' };
    return { item, result };
  });
  const issues = rows.filter(({ result }) => !['matched', 'unchecked'].includes(result.status));
  const unchecked = rows.filter(({ result }) => ['unchecked', 'outdated', 'error'].includes(result.status)).length;
  const visible = showAll ? rows : issues;
  const correctable = rows.filter(({ result }) => result.status === 'differences' && result.check_id && result.correctable_fields?.length);
  return <section className="invoice-checks" aria-labelledby="invoice-checks-title">
    <h2 id="invoice-checks-title">Comprobar facturas con sus originales</h2>
    <div className="packet-actions">
      <button className="button primary" disabled={busy || loading || !online || !items.length} onClick={() => run()}>{busy && !correcting ? 'Comprobando originales…' : 'Comprobar todas las facturas'}</button>
      {(correctable.length > 0 || correcting) && <button className="button" disabled={busy || loading || !online || !correctable.length} onClick={() => correct(correctable)}>{correcting ? 'Corrigiendo discrepancias…' : `Corregir todas las discrepancias (${correctable.length})`}</button>}
      {busy && <button className="button" onClick={() => { stopped.current = true; setProgress('Se detendrá al terminar el registro actual.'); }}>Detener después de esta factura</button>}
    </div>
    {!online && <p>Conéctate a internet para comprobar los originales.</p>}
    <p role="status" aria-live="polite">{loading ? 'Cargando comprobaciones guardadas…' : progress || `${rows.filter(r => r.result.status === 'matched').length} sin diferencias · ${issues.length} para revisar · ${unchecked} pendientes de comprobar o repetir`}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {items.length > 0 && <details className="check-details" open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}>
      <summary>Ver resultados · {issues.length} para revisar{unchecked > 0 ? ` · ${unchecked} pendientes` : ''}</summary>
    {!loading && items.length > 0 && <label className="check-toggle"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Mostrar también coincidencias y pendientes</label>}
    <ul className="check-results">{visible.slice(0, visibleCount).map(({ item, result }) => <li key={item.id}>
      <div className="check-heading"><h3>{item.number || 'Sin número'} · {item.party || 'Sin tercero'}</h3><span>{labels[result.status]}</span></div>
      <p>Fecha registrada: {display(item.date, 'date')}{result.checked_at ? ` · Comprobado: ${new Date(result.checked_at * 1000).toLocaleString('es-ES')}` : ''}</p>
      {result.period_change && result.status !== 'outdated' && <p className="check-period">Posible cambio de trimestre: {result.period_change.recorded} → {result.period_change.detected}. Comprueba la fecha de emisión en el original.</p>}
      {result.status !== 'outdated' && result.differences?.length > 0 && <dl className="check-differences">{result.differences.map(d => <div key={d.field}><dt>{d.label}</dt><dd><span>Registrado: {display(d.recorded, d.field)}</span><span>Original según IA: {display(d.detected, d.field)}</span></dd></div>)}</dl>}
      {result.status !== 'outdated' && result.missing?.length > 0 && <p>No se pudo contrastar: {result.missing.join(', ')}.</p>}
      {result.status !== 'outdated' && result.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}
      {result.status === 'differences' && result.correction_notes?.map((note, i) => <p key={`correction-${i}`}>{note}</p>)}
      {correctionErrors[item.id] && <p className="error" role="alert">{correctionErrors[item.id]}</p>}
      {result.message && <p role="alert">{result.message}</p>}
      <div className="packet-actions">
        {result.status === 'differences' && <button className="button primary" disabled={busy || !online || !result.check_id || !result.correctable_fields?.length} onClick={() => correct([{ item, result }])}>Corregir discrepancias</button>}
        <button className="button" disabled={busy} onClick={() => onEdit(item)}>Revisar registro</button>
        {item.document_id && <><a className="button" href={scopedUrl(`/api/documents/${item.document_id}`)} target="_blank" rel="noreferrer">Ver original</a><button className="text-button" disabled={busy || !online} onClick={() => run([item], true)}>Volver a leer original</button></>}
      </div>
    </li>)}</ul>
    {visible.length > visibleCount && <button className="button" onClick={() => setVisibleCount(count => count + 10)}>Mostrar más resultados ({visible.length - visibleCount} restantes)</button>}
    </details>}
    <details className="check-help-details"><summary>Cómo funciona la comprobación</summary>
    <p>Contrasta fechas, número, tercero, NIF, bases, IVA, retención y total de los {items.length} registros de esta cuenta, de todos los trimestres y años. Señala las fechas que cambiarían el trimestre.</p>
    <p className="check-help">La primera comprobación envía cada PDF o imagen a OpenAI para una lectura independiente. Después reutiliza esa lectura; puedes volver a leer un original. Comprobar no cambia tus registros; los botones de corrección aplican las propuestas guardadas. Deducibilidad, categoría, notas y tratamiento fiscal requieren revisión manual.</p>
    <small>La IA puede equivocarse. «Sin diferencias detectadas» solo indica coincidencias en los campos contrastados; no acredita la validez fiscal del documento. Hasta 100 lecturas nuevas por hora.</small>
    </details>
  </section>;
}
