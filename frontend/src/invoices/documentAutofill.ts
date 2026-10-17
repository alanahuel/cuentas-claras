import type { ExtractionResult, InvoiceForm, InvoiceKind } from "./types";

export const documentFieldLabels = {
  date: "Fecha", number: "Número de factura", party: "Cliente o proveedor",
  nif: "NIF", lines: "Bases e IVA", withholding: "Retención",
} as const;
export type SuggestionKey = keyof typeof documentFieldLabels;
export const suggestionKeys = Object.keys(documentFieldLabels) as SuggestionKey[];
export type Suggestions = Partial<Pick<InvoiceForm, SuggestionKey>>;
// A discriminated union retains the relationship between each key and its value.
export type Suggestion = { [K in SuggestionKey]: {key: K; value: InvoiceForm[K]} }[SuggestionKey];
export function suggestionEntries(values: Suggestions): Suggestion[] {
  return suggestionKeys.flatMap(key => values[key] === undefined ? [] : [{key, value: values[key]} as Suggestion]);
}
export function documentSuggestions(result: ExtractionResult, kind: InvoiceKind): Suggestions {
  const fields = result.fields ?? {};
  const values: Suggestions = {};
  for (const key of ["date", "number", "party", "nif"] as const) {
    if (fields[key] !== undefined) values[key] = fields[key];
  }
  if (result.parties) {
    delete values.party; delete values.nif;
    Object.assign(values, result.parties[kind] ?? {});
  }
  if (fields.withholding !== undefined) values.withholding = (fields.withholding / 100).toFixed(2);
  if (fields.lines) values.lines = fields.lines.map(line => ({...line, base: (line.base / 100).toFixed(2)}));
  return values;
}
export function mergeDocumentSuggestions<T extends Pick<InvoiceForm, "kind">>(form: T, result: ExtractionResult, protectedFields: ReadonlySet<string>): T & Suggestions {
  const values = documentSuggestions(result, form.kind);
  const empty: Required<Suggestions> = {date: "", number: "", party: "", nif: "", withholding: "0.00",
    lines: [{base: "0.00", vat_rate: 0, description: "", irpf_deduct: 100, vat_deduct: 100}]};
  // A classified reading replaces unedited local guesses, including rejected fields.
  const proposals = result.classification ? {...empty, ...values} : values;
  return {...form, ...Object.fromEntries(Object.entries(proposals).filter(([key]) => !protectedFields.has(key)))};
}
