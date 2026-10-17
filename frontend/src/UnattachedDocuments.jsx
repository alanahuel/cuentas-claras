import React, { useRef, useState } from 'react';
import { FileText, Trash2 } from 'lucide-react';

export default function UnattachedDocuments({ items, api, onOpen, onDeleted }) {
  const [selected, setSelected] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [removed, setRemoved] = useState([]);
  const running = useRef(false);
  const visible = items.filter(d => !removed.includes(d.id));
  async function remove() {
    if (running.current || !selected) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try {
      let deleted = [], skipped = 0, pending = 0;
      if (selected.all) {
        for (let start = 0; start < selected.ids.length; start += 1000) {
          const result = await api('/documents/delete-unattached', { method: 'POST', body: JSON.stringify({ document_ids: selected.ids.slice(start, start + 1000) }) });
          deleted.push(...result.deleted_ids); skipped += result.skipped_ids.length; pending += result.files_pending;
          setRemoved(previous => [...previous, ...result.deleted_ids]);
        }
      } else {
        const result = await api(`/documents/${selected.id}`, { method: 'DELETE' });
        deleted = [selected.id]; pending = Number(result.file_pending);
        setRemoved(previous => [...previous, selected.id]);
      }
      setNotice(`${deleted.length} ${deleted.length === 1 ? 'documento eliminado' : 'documentos eliminados'}.${skipped ? ` ${skipped} no se han eliminado porque ya no están disponibles o están asociados a un registro.` : ''}${pending ? ' El servidor completará el borrado de los archivos pendientes.' : ''}`);
      setSelected(null);
      await onDeleted();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); running.current = false; }
  }
  const confirm = (bulk = false) => <div className="unattached-confirm" role="group" aria-label={bulk ? 'Confirmar eliminación de todos los documentos sin registrar' : 'Confirmar eliminación de documento'}>
    <p>{bulk ? `¿Eliminar los ${selected.ids.length} documentos sin registrar?` : `¿Eliminar «${selected.name}»?`} Se borrarán sus originales y lecturas guardadas. No podrás recuperarlos desde la app. Las facturas y gastos registrados se conservan.</p>
    <button type="button" className="button" disabled={busy} onClick={() => setSelected(null)}>Cancelar</button>
    <button type="button" className="button" disabled={busy} onClick={remove}>{busy ? 'Eliminando…' : bulk ? 'Eliminar todos los documentos' : 'Eliminar archivo'}</button>
  </div>;
  return <section className="unattached">
    <h2>Documentos sin registrar</h2>
    <p>Se conservan al cerrar la revisión. Puedes abrirlos o eliminar los que no necesites.</p>
    <button type="button" className="button" disabled={busy || !visible.length} onClick={() => { setSelected({ all: true, ids: visible.map(d => d.id) }); setError(''); setNotice(''); }}><Trash2 size={16} />Eliminar todos ({visible.length})</button>
    {selected?.all && confirm(true)}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="unattached-files">{visible.map(d => <div className="unattached-entry" key={d.id}>
      <div className="unattached-file">
        <button type="button" className="button" disabled={busy} onClick={() => onOpen(d)}><FileText size={16} /><span>{d.name}</span></button>
        <button type="button" className="button" disabled={busy} aria-label={`Eliminar ${d.name}`} onClick={() => { setSelected(d); setError(''); setNotice(''); }}><Trash2 size={16} /></button>
      </div>
      {selected?.id === d.id && confirm()}
    </div>)}</div>
  </section>;
}
