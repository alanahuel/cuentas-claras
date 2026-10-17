import { z } from "zod";

export type InvoiceKind = "income" | "expense";
export type InvoiceStatus = "draft" | "confirmed";
// API money is integer cents. Form money is decimal text so empty/partial input survives editing.
export interface InvoiceLine {
  base: number;
  vat_rate: number;
  description?: string;
  irpf_deduct?: number;
  vat_deduct?: number;
}
export type FormLine = Omit<InvoiceLine, "base"> & { base: string };
export interface Invoice {
  id?: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  date: string;
  number: string;
  party: string;
  nif: string;
  category: string;
  withholding: number;
  note: string;
  document_id: string | null;
  request_id: string;
  version: number;
  lines: InvoiceLine[];
  review_state?: string;
  review_note?: string;
}
export type InvoiceForm = Omit<Invoice, "withholding" | "lines"> & { withholding: string; lines: FormLine[] };
export type EditorInitial = Partial<Invoice> & { upload?: boolean; reextract?: boolean };
export interface EditorUser { id: string; name: string; delegated?: boolean }
export interface ReviewPolicy { required: boolean; can_approve: boolean }
export interface ReviewEntry { action: string; actor_name: string; at: number; version: number; comment?: string }
export type InvoiceTemplate = Pick<Invoice, "party" | "nif" | "category" | "lines" | "withholding" | "note"> & { id: string; label: string; kind: "expense" | "client" };

const centsSchema = z.number().int().nonnegative().safe();
const lineSchema = z.object({
  base: centsSchema, vat_rate: z.union([z.literal(0), z.literal(4), z.literal(10), z.literal(21)]),
  description: z.string().optional(), irpf_deduct: z.number().min(0).max(100).optional(), vat_deduct: z.number().min(0).max(100).optional(),
});
const partySchema = z.object({ party: z.string().optional(), nif: z.string().optional() });
/** External OCR/AI data is checked at runtime before it can modify the form. Unknown keys are stripped. */
export const extractionSchema = z.object({
  id: z.string().optional(), name: z.string().optional(), mime: z.string().optional(),
  text: z.string().optional(), engine: z.string().optional(), warning: z.string().optional(),
  warnings: z.array(z.string()).optional(), ai_error: z.string().nullable().optional(),
  fields: z.object({
    date: z.string().optional(), number: z.string().optional(), party: z.string().optional(), nif: z.string().optional(),
    lines: z.array(lineSchema).min(1).optional(), withholding: centsSchema.optional(), detected_total: centsSchema.optional(),
  }).optional(),
  parties: z.object({ expense: partySchema.optional(), income: partySchema.optional() }).optional(),
  classification: z.object({
    document_type: z.enum(["invoice", "receipt", "other", "unknown"]),
    issuer_country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(), evidence: z.string().optional(),
  }).optional(),
  evidence: z.record(z.string(), z.object({ method: z.string().optional() })).optional(),
});
export type ExtractionResult = z.infer<typeof extractionSchema>;
export function parseExtraction(value: unknown): ExtractionResult & {id: string} {
  const result = extractionSchema.extend({id: z.string().min(1)}).safeParse(value);
  if (!result.success) throw new Error("La lectura del documento contiene datos no válidos. Tus cambios se conservan.");
  return result.data;
}
