export const documentFieldLabels = {
  date: 'Fecha', number: 'Número de factura', party: 'Cliente o proveedor',
  nif: 'NIF', lines: 'Bases e IVA', withholding: 'Retención',
};

export function documentSuggestions(result, kind) {
  const values = {};
  for (const key of Object.keys(documentFieldLabels)) {
    if (result.fields?.[key] !== undefined) values[key] = result.fields[key];
  }
  if (result.parties) {
    delete values.party;
    delete values.nif;
    Object.assign(values, result.parties[kind] || {});
  }
  if (values.withholding !== undefined) values.withholding = (values.withholding / 100).toFixed(2);
  if (values.lines) values.lines = values.lines.map(line => ({...line, base: (line.base / 100).toFixed(2)}));
  return values;
}

export function mergeDocumentSuggestions(form, result, protectedFields) {
  const values = documentSuggestions(result, form.kind);
  // A classified AI reading replaces unedited OCR guesses, including fields it rejects.
  if (result.classification) {
    const empty = {date: '', number: '', party: '', nif: '', withholding: '0.00',
      lines: [{base: '0.00', vat_rate: 0, description: '', irpf_deduct: 100, vat_deduct: 100}]};
    for (const key of Object.keys(empty)) if (values[key] === undefined) values[key] = empty[key];
  }
  return {...form, ...Object.fromEntries(Object.entries(values).filter(([key]) => !protectedFields.has(key)))};
}
