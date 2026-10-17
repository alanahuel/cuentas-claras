# Cuentas Claras

**From invoice files to reviewed records, estimated taxes and a folder ready for an accountant.**

[Español](README.es.md) · [Try the synthetic demo](docs/DEMO.md) · [Architecture decisions](docs/ARCHITECTURE.md)

[![Tests](https://github.com/alanahuel/cuentas-claras/actions/workflows/ci.yml/badge.svg)](https://github.com/alanahuel/cuentas-claras/actions/workflows/ci.yml)

A personal full-stack project built with **React, TypeScript, FastAPI and SQLite**, with local PDF/OCR extraction and optional AI-assisted reading. The interface is Spanish; this README supports English-speaking reviewers.

![Quarterly overview showing synthetic income, expenses and estimated taxes](docs/images/dashboard-desktop.png)

<details>
<summary>Invoice review on mobile</summary>

<img src="docs/images/invoice-mobile.png" alt="Reviewing a synthetic invoice in the mobile form" width="390">

</details>

*Screenshots use synthetic test data only.*

## The real problem

My father struggles with gathering invoices for his accountant, not knowing how much tax he may have to pay, and printing the necessary documents one by one. I planned this application around that workflow: enter documents easily, see an estimate and prepare the invoices for his accountant.

A product for accounting firms is a future idea. The repository includes exploratory agency/team code; it is not presented as a completed accountant-facing product. The portfolio case is an individual preparing their records and documents.

## Try it in five minutes

Requires Python 3.12+, [uv](https://docs.astral.sh/uv/) and Node.js 22+.

```bash
git clone https://github.com/alanahuel/cuentas-claras.git
cd cuentas-claras
python3 scripts/demo.py
```

Open **http://localhost:8030**. Sign in with **demo@example.test** / **synthetic-demo-only**.

The launcher installs locked dependencies, builds the app and creates five synthetic records in the current month. It binds to your own computer, disables external AI and uses a temporary database. Ctrl+C stops it and deletes its server data. It does not touch a normal installation's data. These public credentials are for this disposable demo only.

Upload [`autofill-invoice.pdf`](frontend/tests/fixtures/autofill-invoice.pdf) to try local extraction without an API key or Tesseract. See the [guided walkthrough](docs/DEMO.md) for review, editing and export. Photo OCR needs Tesseract with Spanish/English language data. This is a local demo, not a hosted public service.

## User flow and interface decisions

1. Upload a PDF or photo, or enter a record manually.
2. Review suggested fields alongside the original document.
3. Correct amounts and counterparties; save a draft or confirm a reviewed record.
4. Inspect the period summary and prepare CSV, PDF or ZIP exports for the accountant.

**Manual changes win.** A late extraction cannot overwrite fields the user edited, including deliberately cleared values. **Review is explicit.** Drafts are excluded from estimates, and changing a field clears the review checkbox. **Failures are recoverable.** Local reading remains available when the external provider fails, and malformed extraction data is rejected before modifying the form. **Mobile and offline have clear limits.** The PWA supports local drafts and explicit synchronization; private API responses are not cached by the service worker.

## Code worth reviewing

| Responsibility | Implementation |
| --- | --- |
| HTTP boundary | [`lib/api.ts`](frontend/src/lib/api.ts): CSRF/workspace headers, multipart requests, normalized errors and session-expiry notification. |
| Session lifecycle | [`auth/useSession.js`](frontend/src/auth/useSession.js): restoration, sign-in, sign-out and expiry. [`Login.jsx`](frontend/src/auth/Login.jsx) owns the access form. |
| Invoice workflow | [`InvoiceEditor.tsx`](frontend/src/invoices/InvoiceEditor.tsx): typed state, original preview, manual review and serialization. |
| Extraction contracts | [`types.ts`](frontend/src/invoices/types.ts): separate API/form models and runtime validation with Zod. |
| Suggestion merging | [`documentAutofill.ts`](frontend/src/invoices/documentAutofill.ts): partial proposals, protected fields and typed suggestion rendering. |
| Offline drafts | [`offline.ts`](frontend/src/offline.ts): typed records in IndexedDB, scoped to an authenticated account. |
| Backend | [`main.py`](backend/app/main.py), [`ocr.py`](backend/app/ocr.py), [`document_fields.py`](backend/app/document_fields.py), [`document_ai.py`](backend/app/document_ai.py). |

The browser calls FastAPI. The backend validates records, stores monetary values as integer cents in SQLite and keeps original files private. Authentication uses Argon2id password hashes, HttpOnly session cookies and CSRF protection. Optimistic versions prevent concurrent edits from silently overwriting each other.

The TypeScript migration covers a complete workflow, not just renamed files: extraction response → suggestions → form state → serialized invoice. Form amounts are strings to preserve empty/partial input; API amounts are integer cents. Unknown network data must pass runtime validation. [Read the tradeoffs and remaining boundaries](docs/ARCHITECTURE.md).

## Run a normal local installation

```bash
cd frontend
npm ci
npm run build
cd ../backend
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open **http://localhost:8000** and register. There are no default credentials and no AI keys are required. Local data is created in `backend/data/`, excluded from Git.

For frontend development, run the backend with `APP_ORIGIN=http://localhost:5173`, run `npm run dev` in `frontend`, and open that exact origin. Optional external reading requires both `OPENAI_API_KEY` and `DOCUMENT_AI_MODEL` in the backend environment; native execution does not automatically load `.env`.

## Tests and reproducibility

```bash
cd backend
uv run pytest -q
cd ../frontend
npm run test:unit
npm run typecheck
npm run build
```

Unit tests cover manual-edit preservation, missing proposals, classification, malformed extraction, transport headers and error handling. Browser tests cover the actual form, upload/autofill, offline drafts, registration, deletion, session restoration/expiry and failed logout. Backend tests cover rules, access control and document workflows. Provider responses are simulated; these tests do not measure AI accuracy on real invoices.

For isolated browser tests, use a new directory ending in `cuentas-e2e`:

```bash
# From the repository root, after installing/building:
cd frontend && npx playwright install chromium && cd ..
DATA_DIR=/tmp/review-cuentas-e2e backend/.venv/bin/python scripts/seed-test.py
cd backend
DATA_DIR=/tmp/review-cuentas-e2e APP_ORIGIN=http://127.0.0.1:8000 uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
# In another terminal, from frontend:
npm run test:portfolio
```

GitHub Actions runs backend tests, frontend unit tests, strict type checking, the production build and the portfolio browser suite. Other exploratory browser suites remain in the repository; they are not all part of this CI job.

## Ownership and tools

A personal project by **[Alan](https://github.com/alanahuel)**. My confirmed contribution is identifying the family need and defining the product flow: straightforward document entry, estimated taxes and preparation for the accountant, with a possible future product for accounting firms.

Development has used AI assistance. Codex assisted with the public repository, documentation, this refactor and test execution. This README does not claim that every component was written manually or invent a division of implementation/debugging work. The source, commits, tests and documented decisions make the result inspectable.

## Limits and next steps

This records existing documents and provides estimates; it does not issue certified invoices or submit tax returns. OCR requires human review. Optional AI sends originals to the configured provider. Offline support is limited to drafts, and the application has no 2FA or email recovery.

`main.jsx` still contains older screens and navigation; the editor is isolated but remains substantial. The backend also needs further modularization. Next steps include extracting remaining screens, accessibility testing and measuring time saved with users. No unmeasured usability outcomes are claimed.

The public repository excludes family data, credentials, private history and the original server configuration. Additional [functional reference](docs/FUNCIONALIDAD.md), [scope](docs/ALCANCE.md) and [deployment notes](docs/OPERACION.md) are available in Spanish.
