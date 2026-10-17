import React, { useEffect, useState } from 'react';

export default function ReportSharing({ api, scopedUrl, year, quarter }) {
  const [hours, setHours] = useState(72);
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const query = `?year=${year}&quarter=${quarter}`;
  const load = async () => {
    setLoading(true); setListError('');
    try { setShares(await api(`/reports/shares${query}`)); }
    catch (e) { setListError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let active = true;
    setCreated(null); setNotice(''); setShares([]); setError(''); setListError(''); setLoading(true);
    api(`/reports/shares${query}`).then(data => { if (active) setShares(data); })
      .catch(e => { if (active) setListError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, query]);
  const run = async (task) => {
    setBusy(true); setError(''); setNotice('');
    try { await task(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <section className="report-sharing" aria-labelledby="report-sharing-title">
    <h3 id="report-sharing-title">Informe contable para la gestoría</h3>
    <p>Resumen, cálculos, ajustes, pagos anotados y fichas con justificantes e historial de revisión. Incluye un anexo desde enero para comprobar el IRPF acumulado.</p>
    <div className="packet-actions">
      <a className="button" href={scopedUrl(`/api/reports/preview${query}`)} target="_blank" rel="noreferrer">Ver informe / Imprimir</a>
    </div>
    <form onSubmit={event => { event.preventDefault(); run(async () => {
      const result = await api('/reports/shares', {method: 'POST', body: JSON.stringify({year, quarter, hours})});
      setCreated({...result, url: new URL(result.url, window.location.origin).href});
      setNotice('Enlace creado. Copia el enlace para compartir esta versión del informe.');
      await load();
    }); }}>
      <label className="field"><span>El enlace caduca en</span><select value={hours} onChange={event => setHours(Number(event.target.value))}>
        <option value={1}>1 hora</option><option value={24}>24 horas</option><option value={72}>3 días</option><option value={168}>7 días</option><option value={720}>30 días</option>
      </select></label>
      <button className="button primary" disabled={busy || !navigator.onLine}>{busy ? 'Procesando…' : 'Crear enlace temporal'}</button>
    </form>
    <p className="report-sharing-help">Crea una copia fechada de los datos. Cualquier persona con el enlace podrá leerla y descargar sus justificantes, sin iniciar sesión. Se solicita a los buscadores que no la indexen. Puedes revocar el acceso; las copias descargadas o impresas no se eliminan.</p>
    {created && <div className="report-share-created">
      <label className="field"><span>Enlace para compartir</span><input readOnly value={created.url} onFocus={event => event.target.select()} /></label>
      <button className="button" onClick={() => run(async () => { await navigator.clipboard.writeText(created.url); setNotice('Enlace copiado.'); })}>Copiar enlace</button>
      <p>Caduca el {new Date(created.expires * 1000).toLocaleString('es-ES')}. El enlace solo se muestra al crearlo.</p>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <h4>Enlaces activos de T{quarter} {year}</h4>
    {loading ? <p role="status">Cargando enlaces…</p> : listError ? <div><p role="alert">{listError}</p><button className="button" onClick={load}>Reintentar carga de enlaces</button></div> : shares.length === 0 ? <p>No hay enlaces activos.</p> : <ul className="report-share-list">{shares.map(share => <li key={share.id}>
      <span>Creado el {new Date(share.created * 1000).toLocaleString('es-ES')}<br />Caduca el {new Date(share.expires * 1000).toLocaleString('es-ES')}</span>
      <button className="button" disabled={busy} aria-label={`Revocar enlace creado el ${new Date(share.created * 1000).toLocaleString('es-ES')}`} onClick={() => run(async () => {
        await api(`/reports/shares/${share.id}`, {method: 'DELETE'});
        if (created?.id === share.id) setCreated(null);
        setNotice('Acceso revocado. El enlace y sus justificantes ya no están disponibles.');
        await load();
      })}>Revocar enlace</button>
    </li>)}</ul>}
  </section>;
}
