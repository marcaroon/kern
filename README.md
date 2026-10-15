# KERN

Private, Telegram-first Personal Intelligence System. Bahasa Indonesia, WIB, IDR. A real database-backed application: transactions, budgets, tasks, persistent reminders, notes, reports, owner-only dashboard, and recoverable integration queues.

## Deploy (always online)

KERN runs free on Vercel (app, Telegram webhook) + Supabase (database) + cron-job.org (one per-minute `POST /api/internal/tick` with the internal Bearer secret for reminders, reports, retries, Sheets and maintenance). On Vercel the Telegram mode defaults to webhook, the dashboard origin comes from `VERCEL_PROJECT_PRODUCTION_URL`, `vercel-build` applies pending migrations when `DIRECT_URL` is set, and `DATABASE_CA_CERT` carries the Supabase CA so certificate verification stays on without a local file. Use the Supabase transaction pooler (port 6543) for `DATABASE_URL` and the session pooler for `DIRECT_URL`.

Step-by-step guide for installing your own copy (Bahasa Indonesia, no local tools needed): [docs/PANDUAN_PASANG_SENDIRI.md](docs/PANDUAN_PASANG_SENDIRI.md). Each person runs a separate copy with their own accounts; KERN is single-owner and does not share data between users.

## Run locally

Requirements: Node.js 22.12+ (tested with 22.23.1), npm, a Supabase project with PostgreSQL and one Auth user. Optional: a Telegram bot, Groq, OpenAI, Anthropic or Gemini, Google Sheets, n8n. No live credentials are included. Without Supabase configuration the app shows a setup message; it does **not** expose a fake logged-in dashboard.

From PowerShell in this folder:

```powershell
npm ci
Copy-Item .env.example .env
# Edit .env with your own Supabase settings and owner UUID.
npm run db:generate
npm run db:migrate
npm run dev
```

Open http://localhost:3000 and sign in with the configured owner's email/password. In a second terminal, run the persistent local worker:

```powershell
npm run worker
```

The local worker polls Telegram and processes inbox, reminders, outbound messages, Sheets and retention every five seconds; no public URL is needed. Daily/weekly schedules are supplied by n8n. In production use the imported workflows, or run the worker as a managed process plus n8n for reports. A browser tab is never the scheduler. See [Supabase setup](docs/SETUP_SUPABASE.md), then [Telegram setup and first end-to-end test](docs/SETUP_TELEGRAM.md).

## Commands

| Command                                           | Purpose                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                     | Next development server                                                                                                |
| `npm run db:generate`                             | Generate Prisma client                                                                                                 |
| `npm run db:migrate`                              | Apply checked-in migrations using DIRECT_URL                                                                           |
| `npm run db:dev -- --name change_name`            | Author a migration against a disposable development database                                                           |
| `npm run db:seed`                                 | Explicitly opted-in, labelled demo task/note seed; requires a separate database with `demo` in its name                |
| `npm run sheets:init`                             | Initialize and verify headers on an existing empty Transactions worksheet                                              |
| `npm run telegram -- <id/webhook/polling/status>` | Show sender IDs, register the production webhook (uses NEXT_PUBLIC_APP_URL), return to polling, or inspect the webhook |
| `npm run worker`                                  | Local persistent queue worker (uses actual configured integrations)                                                    |
| `scripts/windows/install-worker-task.ps1`         | Start the worker hidden at Windows logon with automatic restart (`-Uninstall` removes it)                              |
| `npm run test:migrations`                         | Deploy migrations twice and check schema drift on an isolated embedded PostgreSQL database                             |
| `npm run test:ui`                                 | Chromium smoke checks with explicit synthetic UI fixtures (first run: `npx playwright install chromium`)               |
| `npm test`                                        | Credential-free Vitest suite with isolated embedded PostgreSQL                                                         |
| `npm run lint`                                    | ESLint                                                                                                                 |
| `npm run typecheck`                               | Strict TypeScript                                                                                                      |
| `npm run format:check`                            | Prettier                                                                                                               |
| `npm run build` / `npm start`                     | Production build / server                                                                                              |

## Implemented behavior

- Exact BIGINT finances, transfers excluded from totals, accounts, monthly category budgets, threshold deduplication, audited corrections and voids.
- Task creation/edit/completion/cancellation with priority and due dates; searchable editable/archiveable notes.
- One-time/daily/weekly/monthly reminders, original-day monthly clamping, one-occurrence catch-up, generation-based cancellation and persistent delivery status.
- Telegram polling (or secret-token webhook), explicit user-ID allowlist for private chats, durable message deduplication and atomic domain action + reply enqueue.
- Friendly conversational replies with 30-minute context, and plain `ya`/`batal` answers to confirmations.
- Receipt photos read by a vision model and recorded as income/expense after a `ya`; split bill from a receipt or a stated total, computed exactly in rupiah ([details](docs/SETUP_AI.md#receipt-photos-and-split-bill)).
- Groq via the OpenAI-compatible API, or official OpenAI, Anthropic or Google Gemini SDK with schema-constrained structured output, business validation, confidence gating, expiring confirmations, and a small deterministic fallback.
- Transactional Sheets outbox, stable row reservations, RAW writes, verification, bounded retries and manual recovery.
- Authenticated Supabase dashboard and APIs; no browser database credentials; RLS enabled without public policies on application tables.
- Importable n8n workflows for dispatcher, daily briefing, weekly review, Sheets, optional daily recap and content retention.

Clear messages save immediately. Corrections/voiding, cancellations, note edits/archive and budget updates require a second confirmation. Chat confirmations are `konfirmasi <UUID>` and expire in ten minutes. For clarification, resend the **complete corrected request**; arbitrary multi-turn entity merging is not implemented.

## Reliability and operational limits

An external message cannot be guaranteed exactly once without provider idempotency. Telegram rate limiting (429) retries up to five times; timeouts, ambiguous server errors and interrupted sends become `uncertain`. Check the chat before explicitly retrying those. `accepted` means Telegram accepted the API call; the Bot API has no delivery/read receipts. Missing credentials or a blocked bot create visible `blocked` jobs. Successful inbox actions never run again when the reply fails.

Sheets is a reporting copy. Do not manually sort, insert/delete rows, change IDs, or write into the managed Transactions worksheet. Create a separate tab for pivot tables and sorting. Preallocate sufficient rows (e.g. 100,000). Conflicts block synchronization instead of overwriting another transaction.

Built-in request rate limits are per process. Add shared edge limits before multiple app replicas. Reports reflect recorded data only. Dashboard dates are WIB; use the default timezone. Local tests run the SQL migrations on PGlite's embedded PostgreSQL and mock external APIs. Dedicated Supabase migrations and owner login have also passed live checks. Live Telegram round trip, Google permissions, n8n import/activation and multi-process PostgreSQL concurrency still need staging verification with your accounts; see [verification](docs/VERIFICATION.md).

## Architecture and setup

[Architecture](docs/ARCHITECTURE.md) · [Implementation plan](docs/IMPLEMENTATION_PLAN.md) · [API contracts](docs/API.md) · [Supabase](docs/SETUP_SUPABASE.md) · [Telegram](docs/SETUP_TELEGRAM.md) · [AI](docs/SETUP_AI.md) · [Sheets](docs/SETUP_GOOGLE_SHEETS.md) · [n8n](docs/SETUP_N8N.md) · [Roadmap](docs/ROADMAP.md)

Troubleshooting: `CONFIGURATION_REQUIRED` means required environment values are absent; `TELEGRAM_403` means the owner blocked or never started the bot; `TELEGRAM_WEBHOOK_ACTIVE` means polling is blocked by a registered webhook; `SHEETS_ROW_CONFLICT`/`SHEETS_ROW_MOVED` means the managed worksheet was changed. Inspect Integrasi, correct the cause, then retry the specific failed job. A database failure returns an error and never claims a save succeeded. Never paste credentials into issue reports or screenshots.

Production builds inline NEXT_PUBLIC variables. Rebuild after changing those values; restart the development server for local changes. Do not overwrite an existing .env when following setup steps.

Read-only integration diagnostics: `npm run integrations:check`. For the Groq configuration and verification limits, see [AI setup](docs/SETUP_AI.md).
