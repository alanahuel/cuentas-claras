# Frontend boundaries and TypeScript decisions

The refactor separates three responsibilities formerly held by `main.jsx`:

- `lib/api.ts` owns HTTP requests, CSRF/workspace headers and normalized failures. `ApiError.status` remains available to callers. A 401 emits a session-expiry event except for a rejected login.
- `auth/useSession.js` owns restoration, the authenticated actor, active user, sign-in, sign-out and expiry. A generation counter prevents a stale restoration response from overwriting a newer session. Workspace contents remain in the application; session changes invoke its reset callback.
- `invoices/InvoiceEditor.tsx` owns the invoice form, original preview, extraction, manual review and submission. It imports the transport and shared controls rather than relying on enclosing module globals.

`auth/Login.jsx` owns the access form. `components/ui.tsx` contains the existing Button, Field and ErrorBox markup; `lib/format.ts` contains money formatting/conversion. `offline.ts` stores typed invoice drafts by account. These are dependency boundaries, not a claim that the entire application has been modularized.

## A complete typed workflow

`types.ts` defines invoice records, form state, line items, editor props and extraction results. `documentAutofill.ts` combines proposals with protected user fields; `InvoiceEditor.tsx` carries those types through upload, rendering, edits and serialization. All TypeScript is checked in strict mode during `npm run build` and CI. Existing JavaScript remains JavaScript (`checkJs: false`); the repository does not claim a whole-app migration.

### Money: cents versus input text

The API uses integer cents. An input uses strings so clearing a field or entering a decimal does not immediately coerce it to zero or discard partially typed text. `InvoiceLine.base` is a number; `FormLine.base` is a string. Serialization explicitly converts form amounts to cents. These are structural types, not branded numbers: they do not make every accidental use of a number impossible. Runtime extraction validation additionally requires safe, nonnegative integer cents.

### Partial proposals versus complete form state

A reader may not recognize every field. `Suggestions` is a partial selection of six editable fields, not `Partial<Invoice>`: an extraction cannot set status, version or account ownership. Explicit zero and missing values are different. A set records fields the user touched, including deliberately emptied fields. A classified reading can clear rejected local guesses only if those fields are unprotected.

Suggestion entries form a discriminated union: a `lines` entry carries line items, while `withholding` and text entries carry strings. The UI narrows by key before rendering. The two local assertions used to enumerate object keys retain this relationship; they do not cast network JSON into a trusted invoice.

### TypeScript does not validate HTTP responses

`api<T>` describes internal endpoint contracts. External OCR/AI data arrives as `unknown` and passes through a Zod schema before updating form state. Invalid money, unsupported VAT rates and invalid classification fields produce a recoverable error. Unknown keys are stripped. This complements backend validation; it does not prove OCR accuracy or tax correctness. Dates/NIF and business validation remain server responsibilities.

## Regression checks

- Unit tests: manual changes, missing proposals, classification, runtime rejection, forbidden status fields, request headers, multipart uploads and non-JSON failures.
- Browser tests: authentication restoration, failed logout, session expiry while opening an editor, malformed extraction, upload/autofill, offline drafts, registration, deletion and recurring data.
- Backend tests: existing rules, access control and document workflows.

## Remaining tradeoffs

`main.jsx` still coordinates navigation and contains older account, tax and experimental agency screens. The editor is isolated but still large; template management and document loading could become focused hooks in a subsequent change. The session hook remains JavaScript. There is one browser API client rather than a multi-instance dependency-injection system. The public UI remains Spanish because it serves a Spanish-speaking user; English documentation supports technical evaluation.
