# KERN implementation plan

## Scope and assumptions

Build a private single-owner Indonesian application. PostgreSQL (Supabase in production) is authoritative. Supabase provisioning and local configuration were subsequently authorized and completed; other integrations must fail honestly without credentials. No authentication bypass or implicit demo mode. Currency uses exact integer rupiah, timezone defaults to Asia/Jakarta. Node 22 is available; Docker is installed but its daemon is not running.

## Architecture and sequence

1. Foundation: Next.js App Router, strict TypeScript, Tailwind, Prisma 7 stable, PostgreSQL migrations, Supabase owner authentication, request validation and safe error handling.
2. Domain: transactions/accounts/budgets, tasks, notes, reminders, database reports, audited mutations and confirmation flows.
3. Messaging: Telegram polling or secret-token webhook, user-ID allowlist, durable inbox, structured OpenAI interpretation and deterministic fallback, atomic action/reply enqueue.
4. Automation: persistent jobs, occurrence uniqueness, bounded retries, internal authentication, n8n schedules.
5. Sheets: transactional outbox and stable row allocation, idempotent RAW writes and read-back verification.
6. Dashboard: authenticated real data, capture/edit/filter/confirm actions and integration/job health.
7. Verification: deterministic Vitest units and database integration tests, lint, strict typecheck, production build, setup documentation and manual live-service checklist.

## Main entities

Owner ID scopes every personal entity. Account, Transaction (BIGINT, revision, void status), Budget, BudgetAlert, Task, Reminder, Note, InboxMessage (provider ID uniqueness), Job (unique action/occurrence key), SheetSyncOutbox (transaction revision uniqueness and stable sheet row), PendingAction (expiring confirmation), AuditLog, Contact (last inbound timestamp).

## Security and reliability

Server-side Supabase identity verification and owner matching on all private routes. CSRF origin checks for dashboard mutations. Constant-time Telegram webhook secret check and dedicated internal Bearer secret. Strict Zod schemas and explicit action dispatch only. No arbitrary AI tools/URLs/SQL. Database constraints, atomic writes, retry queues and audit records. No secrets or message content in logs. Conversation retention defaults to 30 days.

Exactly-once external delivery cannot be guaranteed by a database and a provider without idempotency support. Telegram timeouts/crashes after a send are marked uncertain for operator reconciliation, never blindly retried. Provider acceptance is recorded as `accepted`; the Bot API reports no handset delivery. Sheets retries write the same reserved row and verify it; the managed worksheet must not be manually sorted or structurally edited. Monthly reminders clamp to the final day, preserving the original anchor day. Catch-up sends one missed occurrence per reminder and advances beyond now.

## External dependencies

Supabase PostgreSQL/Auth; Telegram Bot API; OpenAI Responses structured outputs with configurable model; Google Sheets service account; n8n calling protected internal APIs. Official setup references are recorded in the setup documents.

## Testing

Unit tests for money, dates, recurrence, intent validation, signatures, policy and authorization. Isolated local PostgreSQL-compatible test database for migrations, duplicate inbox races, action rollback, budget alerts, reminder occurrences and outbox retries. Provider mocks only; no paid or live account calls. Run npm test, npm run lint, npm run typecheck and npm run build. Live delivery/authentication require the owner's configured accounts and are reported separately.

## Progress

- [x] Inspect workspace and tooling; record plan.
- [x] Foundation and schema.
- [x] Domain services.
- [x] AI, Telegram, persistent automation and Sheets.
- [x] Dashboard and setup documentation.
- [x] Automated verification and local handover (47 tests; see VERIFICATION.md).

## Staging boundary

Local migrations, domain/API tests and synthetic UI checks are implemented. Dedicated Supabase provisioning, live migrations, owner login/session refresh and authenticated dashboard reads are verified. Actual Telegram round trips, Google write permissions, n8n activation and true multi-process PostgreSQL concurrency still require staging verification. Do not infer production readiness from local tests. See VERIFICATION.md for exact outcomes.
