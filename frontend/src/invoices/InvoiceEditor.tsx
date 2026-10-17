import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Camera, Upload, FileText, LoaderCircle, X, Plus, Trash2, Check } from "lucide-react";
import { api, scopedUrl, errorMessage } from "../lib/api";
import { money, decimal, cents, today } from "../lib/format";
import { Button, Field, ErrorBox } from "../components/ui";
import { saveDraft } from "../offline";
import { documentFieldLabels, documentSuggestions, mergeDocumentSuggestions, suggestionKeys, suggestionEntries } from "./documentAutofill";
import { parseExtraction, type EditorInitial, type EditorUser, type InvoiceForm, type FormLine, type ExtractionResult, type ReviewPolicy, type ReviewEntry, type InvoiceTemplate, type InvoiceStatus, type Invoice } from "./types";
const reviewActions: Record<string, string> = { submitted: "Enviado a gestoría", changes_requested: "Cambios solicitados", approved: "Aprobado y contabilizado", edited: "Datos modificados", corrected_from_original: "Discrepancias corregidas desde el original" };
interface Props { initial: EditorInitial; user: EditorUser; onClose: () => void; onSave: (message: string) => Promise<void> }
export default function InvoiceEditor({ initial, user, onClose, onSave }: Props) {
  const dialog = useRef<HTMLDialogElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    cameraInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<InvoiceForm>({
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
  const protectedFields = useRef(new Set<string>(
    suggestionKeys.filter(key => initial[key] !== undefined && initial[key] !== ""),
  ));
  const [aiConfig, setAiConfig] = useState<{available: boolean} | null>(null);
  const [analysisNotice, setAnalysisNotice] = useState("");
  useEffect(() => {
    if (navigator.onLine) api<{available: boolean}>("/document-analysis").then(setAiConfig).catch(() => {});
  }, []);
  const applyReading = (raw: unknown) => {
    const result = parseExtraction(raw);
    setDocument(previous => ({ ...previous, ...result }));
    setForm(current => ({
      ...mergeDocumentSuggestions(current, result, protectedFields.current),
      document_id: result.id,
    }));
    setDirty(true);
    setChecked(false);
    setAnalysisNotice(result.ai_error ? (aiConfig?.available ? "Lectura local disponible. La lectura automática con IA no se ha completado." : "Lectura local terminada. Revisa los datos detectados.") : "Lectura terminada. Se han rellenado los datos reconocidos y conservado tus cambios manuales.");
  };
  const [document, setDocument] = useState<ExtractionResult | null>(null),
    [preview, setPreview] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [checked, setChecked] = useState(false),
    [dirty, setDirty] = useState(false);
  const [policy, setPolicy] = useState<ReviewPolicy | null>(null);
  const [reviewHistory, setReviewHistory] = useState<ReviewEntry[]>([]);
  const [reviewComment, setReviewComment] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const sendToAgency = policy?.required && !policy?.can_approve;
  useEffect(() => {
    if (!navigator.onLine) return;
    let cancelled = false;
    Promise.all([api<ReviewPolicy>("/review-policy"), initial.id ? api<ReviewEntry[]>(`/invoices/${initial.id}/reviews`) : Promise.resolve([])])
      .then(([nextPolicy, history]) => { if (!cancelled) { setPolicy(nextPolicy); setReviewHistory(history); } })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, []);
  const returnForChanges = async () => {
    setError("");
    setBusy(true);
    try {
      await api(`/invoices/${initial.id}/request-changes`, {method: "POST", body: JSON.stringify({version: form.version, comment: reviewComment.trim()})});
      await onSave("Cambios solicitados. El cliente verá el comentario al abrir su cuenta.");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const [templates, setTemplates] = useState<InvoiceTemplate[]>([]),
    [selectedTemplate, setSelectedTemplate] = useState(""),
    [templateName, setTemplateName] = useState(""),
    [templateNotice, setTemplateNotice] = useState("");
  useEffect(() => {
    api<InvoiceTemplate[]>("/templates")
      .then(setTemplates)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const applyTemplate = (id: string) => {
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
      const saved = await api<{id: string}>(
        "/templates" + (selectedTemplate ? "/" + selectedTemplate : ""),
        {
          method: selectedTemplate ? "PUT" : "POST",
          body: JSON.stringify(body),
        },
      );
      setTemplates(await api<InvoiceTemplate[]>("/templates"));
      setSelectedTemplate(saved.id);
      setTemplateNotice(
        expense
          ? "Gasto recurrente guardado para próximas facturas."
          : "Cliente guardado para próximos ingresos.",
      );
    } catch (e) {
      setError(errorMessage(e));
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
      setTemplates(await api<InvoiceTemplate[]>("/templates"));
      setSelectedTemplate("");
      setTemplateName("");
      setTemplateNotice("Datos guardados eliminados.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const change = <K extends keyof InvoiceForm,>(key: K, value: InvoiceForm[K]) => {
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
    dialog.current?.showModal();
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
    setAnalysisNotice("Leyendo el documento…");
    api("/documents/" + initial.document_id + "/prepare?kind=" + form.kind, {method: "POST"})
      .then(applyReading)
      .catch((e) => { setError(errorMessage(e)); setAnalysisNotice("No se ha completado la lectura. Tus datos se conservan."); })
      .finally(() => setBusy(false));
  }, []);
  const readWithAI = async () => {
    setBusy(true);
    setError("");
    setAnalysisNotice("Leyendo el documento…");
    try {
      applyReading(await api(`/documents/${form.document_id}/ai-extraction?kind=${form.kind}`, {method: "POST"}));
    } catch (e) {
      setError(errorMessage(e));
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
        .catch((e) => setError(errorMessage(e)));
  }, []);
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    if (file.size > 12 * 1024 * 1024) {
      setError("El archivo supera 12 MB.");
      return;
    }
    setBusy(true);
    setAnalysisNotice("Leyendo el documento…");
    try {
      const body = new FormData();
      body.append("file", file);
      const result = await api("/documents?kind=" + form.kind, { method: "POST", body });
      applyReading(result);
      setPreview(URL.createObjectURL(file));
    } catch (e) {
      setError(errorMessage(e));
      setAnalysisNotice("No se ha completado la lectura. Tus datos se conservan.");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };
  const lineChange = <K extends keyof FormLine,>(index: number, key: K, value: FormLine[K]) =>
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
  const save = async (status: InvoiceStatus | "submit") => {
    setError("");
    setBusy(true);
    try {
      const payload: Invoice & {review_action: "submit" | "save"} = {
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
      setError(errorMessage(e));
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
      setError(errorMessage(e));
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
                onClick={() => cameraInput.current?.click()}
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
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={32} />
                <strong>
                  {busy ? "Leyendo el documento…" : "Selecciona una factura"}
                </strong>
                <span>Foto o PDF · hasta 12 MB · 8 páginas</span>
                <small>{aiConfig?.available ? "Se leerá automáticamente con OpenAI para rellenar los datos." : "Se extraerán los datos con lectura local, sin enviar el archivo a un proveedor externo."}</small>
              </button>
            )}
            {busy && (
              <p className="working" role="status">
                <LoaderCircle size={18} className="spin" /> Procesando…
              </p>
            )}
            {form.document_id && <div className="ai-reading">
              <p>{aiConfig?.available ? "Lectura automática con IA. El documento se envía a OpenAI; comprueba los datos antes de guardar." : "Lectura local. Comprueba los datos antes de guardar; la IA externa no está activada."}</p>
              {document?.ai_error && aiConfig?.available && <Button type="button" disabled={busy || !navigator.onLine || !aiConfig?.available} onClick={readWithAI}>Reintentar lectura con IA</Button>}
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
              {([
                ["expense", "Gasto"],
                ["income", "Ingreso"],
              ] as const).map(([value, label]) => (
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
                          for (const key of ["party", "nif"] as const) {
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
            {document?.fields && suggestionKeys.filter(key => key !== "withholding").some(key => documentSuggestions(document, form.kind)[key] === undefined) && (
              <p className="document-missing">No se ha podido leer: {suggestionKeys.filter(key => key !== "withholding").filter(key => documentSuggestions(document, form.kind)[key] === undefined).map(key => documentFieldLabels[key]).join(", ")}. Comprueba estos campos en el original.</p>
            )}
            {document?.fields && (
              <details className="extraction-review">
                <summary>Datos detectados · {document.engine}</summary>
                <p>Los campos que has editado se conservan. Puedes aplicar una propuesta concreta aquí.</p>
                <dl>
                  {suggestionEntries(documentSuggestions(document, form.kind)).map((suggestion) => (
                    <div key={suggestion.key}>
                      <dt>{documentFieldLabels[suggestion.key]}</dt>
                      <dd>
                        <span>{suggestion.key === "lines" ? suggestion.value.map(line => `${money(cents(line.base))} · IVA ${line.vat_rate}%`).join(" / ") : suggestion.key === "withholding" ? money(cents(suggestion.value)) : suggestion.value}</span>
                        {document.evidence?.[suggestion.key]?.method === "calculated" && <small>Calculado a partir del porcentaje leído.</small>}
                        <Button type="button" disabled={busy} onClick={() => change(suggestion.key, suggestion.value)} aria-label={`Aplicar propuesta: ${documentFieldLabels[suggestion.key]}`}>Aplicar</Button>
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
                  maxLength={100}
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
                  maxLength={200}
                  value={form.party}
                  onChange={(e) => change("party", e.target.value)}
                />
              </Field>
              <Field label="NIF del tercero">
                <input
                  required
                  maxLength={30}
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
                rows={2}
                maxLength={2000}
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
                {returnOpen && <div><Field label="Qué debe corregir el cliente"><textarea rows={3} maxLength={2000} value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} /></Field>{dirty && <p>Hay cambios sin guardar. Guarda el documento como borrador o cierra y vuelve a abrir la revisión para devolver la versión original.</p>}<Button type="button" disabled={busy || dirty || !reviewComment.trim()} onClick={returnForChanges}>Enviar solicitud de cambios</Button></div>}
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
