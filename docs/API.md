# API contracts

All data routes run on Node. Success: `{ "data": ... }`. Errors: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "fields": [...] } }`. IDR values serialize as decimal strings. Dates are ISO timestamps with offsets; returned timestamps are UTC. All private responses use no-store. Statuses: 200/201 success, 400 malformed JSON, 401 unauthenticated, 403 wrong owner/origin, 404 missing record, 409 conflict/ambiguity/stale version, 413 body too large, 422 validation, 429 rate limit, 503 configuration/provider/database issue.

## Authentication

POST /api/auth: `{email,password}` authenticates with Supabase and rejects non-owner users. DELETE /api/auth logs out. Both require Origin matching NEXT_PUBLIC_APP_URL. All following private endpoints require a verified Supabase cookie session and configured owner UUID. Mutations also require matching Origin; no anonymous data or bearer-key dashboard bypass exists.

| Endpoint                 | Methods          | Behavior                                                                                                               |
| ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| /api/transactions[/UUID] | GET, POST, PATCH | List/get/create; PATCH replaces editable transaction fields or `{action:"void", confirmed:true, expectedUpdatedAt}`    |
| /api/tasks[/UUID]        | GET, POST, PATCH | List/get/create/replace editable task fields, including completed/cancelled status                                     |
| /api/reminders[/UUID]    | GET, POST, PATCH | List/get/create/reschedule/enable/cancel; active schedules must be in future                                           |
| /api/notes[/UUID]        | GET, POST, PATCH | List/get/create/edit/archive                                                                                           |
| /api/budgets             | GET, POST        | Current-month usage / upsert by month+category; POST requires confirmed:true                                           |
| /api/accounts            | GET, POST        | List/create account by unique owner+name                                                                               |
| /api/dashboard           | GET              | Current totals, previous month, tasks, reminders, notes, queues                                                        |
| /api/finance             | GET              | Daily/monthly/previous-month totals, category breakdowns, budgets                                                      |
| /api/reports             | GET              | Recorded report; ?kind=daily, weekly (default), or recap                                                               |
| /api/health              | GET              | DB connectivity, configuration flags, recent outbound jobs/pending sync/inbox errors; no secrets                       |
| /api/jobs/UUID           | PATCH            | Retry blocked/failed/uncertain outbound job with confirmed:true; uncertain also requires acknowledgeDuplicateRisk:true |
| /api/sync/UUID           | PATCH            | Requeue failed/retry outbox event with confirmed:true                                                                  |
| /api/inbox/INBOX_ID      | PATCH            | Requeue failed inbox row with confirmed:true (URL-encode ID)                                                           |

GET lists return `{rows,count}` (budgets/accounts omit count); UUID gets still return rows, empty if absent. Common filters: `q`, `page` (50 records), `category`, `type`, `accountId`, `from` inclusive, `to` exclusive, `status`, `tag`; unsupported/invalid query fields are rejected. Each collection applies relevant fields. Tasks accept open/in_progress/completed/cancelled/overdue/all. Notes default to unarchived; archived selects archive. Finance uses local calendar boundaries. Reports are generated from DB facts, never LLM estimates.

PATCH operations are full editable-field replacements, not arbitrary partial patches. Record edits require `confirmed:true` and `expectedUpdatedAt` from the latest GET; a stale timestamp returns 409. No physical deletion API is provided. Voids/cancellations/archives preserve history. Monetary strings must be positive and <= PostgreSQL signed BIGINT max. Transfers require distinct accountId and toAccountId belonging to the owner. IDs are validated; the model cannot bypass ownership.

Transaction create example:

```json
{
  "type": "expense",
  "amount": "35000",
  "occurredAt": "2026-10-12T12:00:00+07:00",
  "category": "food",
  "description": "Makan siang",
  "paymentMethod": "QRIS",
  "accountId": null,
  "toAccountId": null
}
```

Task: `{title,description?,status?,priority:1|2|3,dueAt?:ISO|null,project?}`. Reminder: `{title,message?,scheduledAt:ISO,timezone:"Asia/Jakarta",recurrence:"once"|"daily"|"weekly"|"monthly",status:"active"|"cancelled",taskId?}`. Note: `{title,content,tags?:string[],category?,project?,archived?:boolean}`. Budget: `{month:"YYYY-MM",category,amount:"1000000",warningPercent:80,confirmed:true}`. POST/PATCH inputs are strict and reject extra editable fields.

## Webhook and internal routes

POST /api/webhooks/telegram exists only when TELEGRAM_MODE=webhook (404 otherwise) and requires the X-Telegram-Bot-Api-Secret-Token header to equal TELEGRAM_WEBHOOK_SECRET (at least 32 characters) before the body is read. Only private-chat messages from allowlisted Telegram user IDs enter the inbox. Duplicates return success but create no repeated action. In the default polling mode the worker reads getUpdates instead.

POST /api/internal/{dispatch|sheets|daily|weekly|recap|maintenance} requires `Authorization: Bearer KERN_INTERNAL_API_SECRET`, minimum 32-character configured secret. No browser session or Origin required. dispatch processes pending inbox, materializes due reminders and sends queued messages. daily/weekly/recap enqueue one report per local period. sheets processes up to 20 pending/retry items; maintenance redacts old completed conversation content. These endpoints may be retried safely; uncertain external sends are not automatically replayed.
