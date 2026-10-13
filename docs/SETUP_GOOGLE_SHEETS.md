# Google Sheets reporting copy

1. In Google Cloud, create/select a project, enable Google Sheets API and create a service account. Grant the account access to only the intended spreadsheet; project-wide access is unnecessary.
2. Create a private spreadsheet, add an empty worksheet named exactly `Transactions`, and preallocate enough rows (e.g. 100,000). Share it as Editor with the service account's client_email.
3. Set GOOGLE_SHEETS_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON (single-line JSON, preserving escaped newlines in private_key). Keep the JSON server-only and out of Git.
4. Run `npm run sheets:init`. It initializes A1:L1 only when empty or already matching; mismatched headers are rejected. It verifies the result before reporting success.
5. Run the local worker or activate the n8n sheets workflow. Create an expense and inspect the stable transaction ID and RAW integer-string amount. Correct/void the transaction and verify the same row changes.

Columns: transaction_id, transaction_date, type, amount_idr, category, description, payment_method, account, status, created_at, updated_at, to_account. Exact IDR strings avoid Sheets floating-point truncation for large values and RAW prevents formula injection through descriptions. If building Sheets formulas for typical-sized amounts, explicitly convert in a separate reporting tab and understand Sheets numeric precision limits.

Never sort, insert/delete rows, change IDs or edit cells in this managed worksheet. A reserved PostgreSQL sequence fixes each transaction's target row. Retries search IDs, reject duplicates/moved rows/conflicts, rewrite the same row and verify cells. Create a separate sheet/view for sorting and reporting. If a row is moved, restore its reserved position from the canonical database before retrying; do not manually append another copy. Deleted rows can be rewritten from the database. An exhausted grid must be expanded in Google Sheets before retrying.

If credentials are absent, outbox events remain pending and capture continues. API/network errors are recorded by safe code and retried up to five times. Fix the cause and retry through Integrasi. The worker always writes the latest transaction revision and can mark older outbox revisions synchronized together. A remote success with a lost response does not create a new row on retry.

Automated tests use an in-memory Sheets port including lost responses; real API authentication, sharing and write permissions need manual verification.

Official references: [Reading and writing values](https://developers.google.com/workspace/sheets/api/guides/values), [values.update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update).
