# Synthetic demo walkthrough

Run `python3 scripts/demo.py` from the repository root. Requires Python 3.12+, uv and Node.js 22+. The command installs locked dependencies, type-checks and builds the frontend, creates a temporary database and starts the app on **http://localhost:8030**.

- Email: `demo@example.test`
- Password: `synthetic-demo-only`
- Stop: Ctrl+C; the temporary server directory is deleted.

The demo binds to loopback, disables external AI even if your shell has API credentials, and seeds five synthetic records in the current month. It does not use the normal application's database. Browser-side offline drafts belong to this demo origin; clear site data if you leave unsynchronized drafts. Demo credentials are public and must never be used for real accounts or public hosting.

## A five-minute review

1. **Overview / Vista general:** inspect income, expenses and the estimated tax reserve. Only reviewed records count. The outstanding draft is visible separately.
2. **Upload / Añadir documento:** upload `frontend/tests/fixtures/autofill-invoice.pdf`. This synthetic PDF supports local extraction without Tesseract or an API key. For photo OCR, install Tesseract with Spanish and English language data.
3. **Autofill:** edit a proposed invoice number; switch between expense and income to see the counterparty change. Manually changed fields remain protected. Expand **Datos detectados** to apply a specific suggestion.
4. **Review:** check the original and amounts, tick the review checkbox, then confirm. The checked state is cleared whenever the form changes.
5. **Hand-off / Facturas y gastos:** export CSV or generate the PDF/ZIP folder for the accountant. This prepares documents; it does not submit a tax return.

The UI is Spanish. The product serves an individual organizing documents for their accountant; the experimental agency/team screens are not presented as a finished product for accountants. This is a local, disposable demo, not a publicly hosted service.
