# Architecture

Next.js 16 App Router / React / strict TypeScript serve the private dashboard and thin HTTP routes. Controllers authenticate/authorize and validate HTTP boundaries. Domain services own all business rules and Prisma transactions. Integrations are isolated adapters for Telegram, OpenAI/Anthropic/Gemini and Google Sheets. n8n only schedules authenticated backend calls.

PostgreSQL is authoritative. Monetary amounts are positive BIGINT values with type income/expense/transfer, returned as decimal strings. No floating-point amount conversion. Supabase Auth is verified server-side with `getUser`, then compared with the configured owner UUID. Every personal query is owner scoped. Browser API access to application tables is denied by RLS (no public policies); only the server's database role accesses them.

## Durable processing

1. Poll Telegram getUpdates from the worker (or accept a webhook with a constant-time secret-token check) and keep only private chats from allowlisted user IDs.
2. Insert InboxMessage by stable ID `tg:<chat>:<message_id>`, commit, then confirm the update offset. No AI call in the receive path.
3. Dispatcher locks a pending inbox row (`FOR UPDATE SKIP LOCKED`) and serializes owner actions using a transaction advisory lock. A bounded AI call returns one validated intent. The action, audit, optional Sheets event and outbound reply commit together. A savepoint rolls back domain writes when returning a validation/clarification response.
4. Claimed outbound jobs persist `processing` before calling Telegram. Successful response yields a provider ID and `accepted` (the Bot API has no delivery receipts). A lost response or crashed worker is `uncertain` and requires operator review.
5. Reminder dispatch locks due records, inserts a uniquely keyed occurrence, and advances the schedule in the same transaction. Editing/cancellation increments generation and cancels pending old jobs. A send already in flight cannot be recalled.
6. Finance mutations and SheetSyncOutbox writes commit together. One Sheets writer holds a PostgreSQL advisory lock while writing the latest transaction revision. A sequence reserves one fixed sheet row per transaction. Retries search the stable ID, reject moved/duplicate/conflicting rows, write with RAW, and verify all cells. Response loss is safe because the same row is rewritten. No blind append.

## Recurrence and retry policy

All timestamps use timestamptz UTC storage. Display is WIB. Monthly schedules retain original anchor day, clamping in short months. After downtime one oldest due occurrence is queued; nextRunAt jumps beyond now. One-time overdue reminders remain sendable until cancelled. This prevents a burst of all missed recurrences.

Transient known rejections retry after 30, 60, 120, 240 seconds, capped at five total attempts. Blocked credentials/chat errors and uncertain sends never retry automatically. An interrupted send is detected after two minutes. Sheets uses the same bounded backoff but safely retries ambiguous writes. Failed/blocked work is visible and can be requeued with owner confirmation. Never retry `accepted` jobs.

## Data model

Account, Transaction, Budget, BudgetAlert, Task, Reminder and Note hold personal records. InboxMessage is a durable inbox and replay ledger. Job is an outbound outbox with unique action/occurrence key. SheetSyncOutbox tracks transaction revisions. PendingAction stores expiring, single-use chat confirmations with target version checks. AuditLog preserves before/after for significant changes.

## Privacy and retention

- Telegram receives incoming/outgoing chat text and the owner's Telegram user ID.
- The AI provider (OpenAI, Anthropic or Gemini) receives only the current message and current local date/time instructions. OpenAI requests use `store:false`. Gemini's free tier may use that text to improve Google's products. KERN does not send the database or history; provider account retention policies still apply.
- Google receives synchronized transaction columns, including descriptions/account names.
- Supabase/hosting hold personal data and server secrets; n8n holds its dedicated internal API credential and scheduler logs. Restrict n8n execution logging and operator access.
- Processed inbox content and completed outbound content are redacted after 30 days by maintenance; IDs remain for replay protection. Old confirmation payloads are deleted. Failed/pending job payloads remain for recovery and should be reviewed periodically. Financial records and audit history persist until the owner follows an explicit deletion/export procedure; no automated financial deletion.
- Structured logs contain event codes only, not raw errors, authorization values or message bodies. Backups contain personal data: enable managed encrypted backups, restrict access and test restoration before production use.

## Deliberate boundaries

Single owner; no multi-user tenant administration. No general autonomous tools or arbitrary URLs. Keyword/metadata memory only. Domain handlers accept one action per message. Contextual follow-up merging is deferred; resend the full request. AI interpretation can still misunderstand language, so material changes require confirmation. A long-lived Node host or a scheduler timeout supporting the bounded batch is required; no fire-and-forget background work after an HTTP response.
