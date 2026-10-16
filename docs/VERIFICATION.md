# Local verification and deployment gate

## Production deployment — 15 October 2026

After the owner signed in to Vercel, production GROQ_API_KEY (sensitive), GROQ_MODEL and AI_PROVIDER=groq were configured from the private local settings. The previous production provider was Gemini. Deployment `dpl_3kL47pm48FQuZAaTXQoFA3qv6Aw3` reached READY and was aliased to https://kern-nine.vercel.app. Vercel CLI 64.2.0 was used because the installed 41.6.1 could no longer upload. Hosted build and TypeScript passed; all six migrations were already applied.

Production smoke checks passed: login HTTP 200; health, internal tick and webhook without credentials HTTP 401; a signed synthetic bot update returned accepted=0 and created no user action. No real Telegram message was sent and no real spreadsheet cells were written by these checks. Groq live basic inference was verified locally as described below, not through a real production chat round trip. Earlier statements about missing deployment credentials describe the state before this deployment.

## Groq and Telegram update — 15 October 2026

- 67 automated tests passed in five files, including Groq endpoint/schema validation, refusal/truncation/outage fallback, invented amounts, single-use confirmations, bounded webhook batches, and preserving occupied Sheets rows with blank IDs.
- ESLint, TypeScript/Next route generation, and production Next.js build passed.
- Read-only live checks: database SELECT 1 succeeded; Telegram getMe/getWebhookInfo succeeded with an active webhook, no pending updates and no reported historical webhook error; Google Sheets Transactions headers were read and matched.
- The local TELEGRAM_MODE was changed from polling to webhook to match the existing remote webhook. No remote webhook configuration was changed.
- Groq was subsequently configured locally and selected successfully. Live synthetic requests through the actual `interpret` service verified expense extraction (IDR 35000), a tomorrow-at-09:00 reminder in Asia/Makassar, and a general greeting. Six requests yielded four successful validated responses, one HTTP 400 (cause not established), and one HTTP 429 (rate limit); the failed calls returned deterministic clarification instead of executing actions. This verifies basic inference, not sustained availability or broad language accuracy. No API keys or raw provider errors were printed.
- No live Telegram message was sent, no real spreadsheet cells were written, and no production migration or deployment was performed. Read access does not prove write permission, and bot connectivity does not prove end-to-end delivery. The diagnostics command is `npm run integrations:check`.

Follow-up after the Telegram screenshot: the visible reply text matches the old templates. Deployment access is currently blocked because Vercel CLI has no login credentials. The AI prompt now explicitly distinguishes bank names/payment descriptions from account UUIDs, requires transaction titles, and the adapter rejects account IDs not explicitly present in the input. A synthetic live book-purchase example with `50rb`, QRIS and a fictional bank passed the transaction schema without assigning an account ID. The user's original financial message was not submitted to Groq: automatic approval review blocked that export. Its exact production failure remains unconfirmed. All 68 automated tests, lint and typecheck passed for the follow-up.

The older verification record below is historical and was not fully rerun for this update.

Verified on Windows, Node 22.23.1, 12 October 2026. No live chat sends, paid model requests, real Sheets writes or personal-data seeds were performed.

| Check                     | Result and scope                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                | 47 tests pass across four Vitest files. Isolated PGlite PostgreSQL + Prisma domain integration, HTTP controllers, AI adapter mocks and security/unit tests.                                                                                                                                            |
| `npm run test:migrations` | All four migrations deploy successfully to an isolated embedded PostgreSQL database. A second deploy has no pending migrations; Prisma schema diff reports no differences.                                                                                                                             |
| `npm run test:ui`         | Chromium smoke checks: all seven dashboard views, desktop/mobile layout without page overflow, task creation/completion, transaction void, uncertain-message retry confirmation and API error state. API fixtures are synthetic and visibly labelled; this is not live Supabase/Telegram verification. |
| `npm run lint`            | ESLint passes without warnings.                                                                                                                                                                                                                                                                        |
| `npm run typecheck`       | Prisma generation, Next route type generation and strict TypeScript pass.                                                                                                                                                                                                                              |
| `npm run format:check`    | Prettier passes.                                                                                                                                                                                                                                                                                       |
| `npm run build`           | Production Next.js build passes without external credentials.                                                                                                                                                                                                                                          |
| `npm audit --omit=dev`    | Zero known production dependency vulnerabilities in the check.                                                                                                                                                                                                                                         |
| Secret exclusion          | `.env`, generated clients, local test outputs and node_modules are excluded from Git. Existing user .env is preserved.                                                                                                                                                                                 |

## Cases covered

Exact amounts above JavaScript number precision; transfer/void exclusion; ambiguous amounts causing no write; Jakarta day/week boundaries; month-end recurrence and catch-up; transactional rollback of financial/audit/outbox writes; owner-scoped account resolution; budget warning deduplication; repeated Telegram update delivery and confirm-after-commit polling; strangers/groups/bots ignored; Telegram error-to-disposition mapping without token leakage; unsupported/unauthorized inputs; task ambiguity; expiring single-use confirmation; no fabricated notes; due occurrence uniqueness; successful-send idempotency; bounded 429 retries; timeout/crash uncertainty; cancellation of queued occurrences; latest-revision Sheets writes; successful remote write with lost response; missing optional integrations; invalid webhook secret/internal credentials; invalid request JSON/schema; CSRF origin checks; stale-write conflicts; provider failure/malformed output fallback; safe error logging.

## Remaining live checks

1. Verify denial for a second real Auth user before expanding account access. Owner login/session refresh and unauthenticated denial have been verified live as recorded below; no synthetic Auth users were added to the live project.
2. Follow SETUP_TELEGRAM.md for the first actual Rp35.000 transaction round trip and reminder delivery test.
3. Verify the Google service account's actual spreadsheet permission and initialize headers. Confirm capture remains available during a Google outage.
4. Import, configure and activate n8n workflows; verify scheduler timezone and call reachability.
5. Run concurrent-worker and crash-recovery tests against full PostgreSQL. PGlite uses a single connection in these tests and does not prove multi-process production behavior. Perform a backup restoration drill and configure shared rate limits before multiple app replicas.

Supabase database/Auth are now configured in the local workspace. Telegram, OpenAI/Anthropic, Google Sheets and n8n live operation remain unverified.

## Live Supabase configuration

Verified 12 October 2026 against the dedicated Free-plan `kern` project (Singapore):

- All four migrations applied successfully; a second deploy reported no pending migrations.
- All 14 application tables (12 after the Telegram migration) have RLS enabled and no public policies. `anon` and `authenticated` cannot read migration metadata; their application-table reads returned no rows. Tables contain no seeded application data.
- Session-pooler client TLS certificate and hostname verification passed using the Supabase CA. Server SSL enforcement reports applied successfully. Pooler-to-database transport is not inferred from client TLS verification.
- Public signup and anonymous Auth disabled; one owner account created for the email explicitly supplied by the user.
- Supabase password login, refresh token rotation and server-side user verification passed.
- Chromium signed in through KERN's actual login form. Dashboard, transactions, tasks, reminders, notes, finance and health endpoints returned HTTP 200; database health reported connected.
- Unauthenticated access returned HTTP 401, cross-origin mutation returned HTTP 403, and access after logout returned HTTP 401.
- All 47 tests, lint, strict typecheck and production build passed again with the configured environment. No financial/task/note records or outgoing messages were created during live verification.

The local app uses `http://localhost:3000`. Login details and the CA are in Git-ignored `.local/`; server credentials remain in `.env`. No service-role key is stored in public environment variables. This is local application configuration, not a public deployment.

## Channel change (13 October 2026)

WhatsApp Cloud API was abandoned: Meta reported the business portfolio as `can_send_message: BLOCKED` (business verification, incomplete business profile, WABA payment method), and no webhook was ever delivered. Telegram Bot API replaced it. Migration `202610130001_telegram` renames `InboxMessage.phone` to `sender`, renames job kind `whatsapp` to `message`, and drops the WhatsApp-only `Contact` and `DeliveryReceipt` tables (one Meta receipt row, no personal records). The Meta app, its webhook subscription and the WABA still exist in Meta and can be deleted there.

- Live round trip verified on 13 October 2026 in polling mode with the owner's allowlisted Telegram account: `/start` produced the help reply, and "Catat pengeluaran 35 ribu buat makan siang QRIS" created exactly one active expense of 35000 (food, QRIS, source `telegram`) with one audit row and one pending Sheets outbox event (Sheets not configured). Both inbox rows are `processed`; both reply jobs are `accepted` and the owner confirmed receiving the replies. Webhook mode, proactive reminder delivery, a blocked bot (403) and non-owner senders have not been tested live.
- Google Sheets verified live on 13 October 2026: service account `kern-sheets` (no project roles) shared as Editor on the owner's spreadsheet; a `Transactions` worksheet of 100,000 x 12 was created, `npm run sheets:init` verified headers, and the worker synced the pending Rp35.000 expense to row 2 with matching transaction_id and RAW amount `35000`. Correction/void row rewrites and a Google outage have not been tested live.
- Anthropic provider: the key and model were accepted by the Models API, but live requests were rejected for an empty prepaid credit balance; behaviour is covered by mocked tests only.
- Gemini provider evaluated live on 13 October 2026 (free tier) through KERN's real `interpret()` path with seven Indonesian cases (casual expense with e-wallet, grouped-thousands income, "lusa jam 3 sore" reminder, "kemarin" date, foreign currency, weekly summary, ambiguous amount). All candidates understood the cases when they answered; differences were transient provider failures. `gemini-3-flash-preview` returned 503 "high demand" and took 8–18 s; `gemini-3.8-flash` took 1.5–6.5 s with intermittent failures; `gemini-3.5-flash-lite` answered 7/7 in about 1.6 s and is the configured model. Failures fall back to the deterministic patterns. Accuracy on broader real messages is not established by seven cases.
- Production deployment on Vercel (Hobby, region sin1) verified on 13 October 2026: `vercel-build` connected to the session pooler with `sslmode=verify-full` and the inline CA and reported no pending migrations; runtime uses the transaction pooler (6543) with the inline CA (certificate verification on). `/login` returns 200; `/api/health`, `/api/internal/tick` without the Bearer secret and the webhook without the secret token return 401. One authenticated `tick` ran dispatch and Sheets without errors. The Telegram webhook is registered with a secret token and no delivery errors; a signed update from a non-allowlisted sender stored nothing. The cron-job.org schedule and a real message through the production webhook still need confirmation.
- Fixed a regression from the initial commit: the foreign-currency guard regex contained literal backspace characters instead of `\b`, so a model-returned amount for "10 dolar" was not rejected. A regression test now covers it.

## Dependency caveat

The full development dependency audit reports five high-severity entries in the `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` chain, stemming from an unpatched nested-pattern stack-exhaustion advisory in braces 3.0.3. These are development lint tooling, not production application dependencies. Avoid running tooling on untrusted repository patterns; recheck upstream releases before deployment/build infrastructure accepts untrusted code. Prisma toolchain transitive deepmerge-ts/mysql2 versions are overridden to patched releases and tested by migration/build checks. ESLint 9 is retained for the current Next lint plugins' peer compatibility; update the lint chain together when its plugins support ESLint 10.

## Known product boundaries

One owner, text messages and receipt photos, keyword memory and one action per message. Conversation context covers the last 30 minutes only. Dashboard timezone is WIB. Missing/uncertain provider deliveries need operator configuration/reconciliation. The managed Sheets tab requires fixed rows. Split bills record the owner's share as an expense and friends' shares as debts; settling a debt is not income. Calendar and email are roadmap features, not implemented capabilities. Meaning search scans notes in memory and suits a few thousand notes.

## Friendlier chat, receipts and split bill (15 October 2026)

Migration `202610150001_receipt_media` adds nullable `InboxMessage.fileId` and `fileMime`. All 95 tests (credential-free, embedded PostgreSQL), lint, strict typecheck, Prettier, the production build and `npm run test:migrations` passed. Tests cover photo ingestion and size limits, token-free download errors, provider request shapes for Groq and Gemini images, receipt normalisation, exact split arithmetic, `ya`/`batal` confirmation, proposal superseding, owner-scoped conversation history and amounts taken only from the user's own words.

**Not verified live:** no real receipt photo has been read by any provider. Groq vision (`GROQ_VISION_MODEL`, non-strict JSON Schema with images), OpenAI/Anthropic/Gemini image input, Telegram `getFile` downloads and the new persona's tone on real messages are covered by mocked tests only. Before relying on them, send a few real receipts (clear, blurry, with tax/service, a transfer proof) and a split caption to the production bot and compare the readings with the paper receipts.

## Live receipt test and fixes (15 October 2026)

The first two real receipt photos sent to production failed. Reproduced locally with the stored Telegram `file_id`s (read-only database access) and the production providers:

- `qwen/qwen3.8-27b` on Groq returned inconsistent JSON under the first prompt: amounts as `"/ 70,000"`, sentences ("This amount is uncertain…") in amount fields, and the receipt typed as income. The old normaliser could then throw a validation error, shown as the generic "Belum bisa aku simpan" reply.
- The second photo hit Groq's free-tier limit (HTTP 429, 1,000 output tokens per minute; tokens per minute 8,000), because both photos arrived within a minute.
- Telegram `getFile` and file downloads from this machine took 0.6–10 s and once hit a 16 s connect timeout.

After the fixes (stricter prompt, nullable amounts, last-number parsing, never-throwing normalisation, provider fallback list, one short 429 retry, download retry, tolerant date parsing), qwen read the first photo of the Sate Balibul receipt correctly four times and the second photo once (two other attempts on it within the same minute were rate limited), and `gemini-3.5-flash-lite` read each photo correctly once: five items summing to Rp154.000, total Rp154.000, category food, printed date 1 Oct 2026 18:08. One qwen run noted a cut-off bottom edge as a problem; one Gemini run also read the payment method "Tunai". This is two photos of one receipt; other layouts (tax/service lines, e-wallet proofs, long receipts) remain untested. All 100 tests, lint, typecheck, Prettier, build and migration checks passed.

## Buttons, debts, bills and insights (15 October 2026)

Migration `202610150002_debts_bills` adds `Debt` and `Bill` (RLS enabled, CHECK constraints on direction, amounts and due day). 112 tests, lint, strict typecheck, Prettier, production build and `npm run test:migrations` passed. Tests cover button payloads, owner-only and duplicate taps, cancelling the tapped proposal, atomic split-bill debts, partial and over-payment, direction ambiguity, nudge idempotency, bill reminder stages and the 09:00 rule, double payment, variable amounts, day-31 clamping, insight arithmetic and the text/vision provider chains.

Live intent check against Groq `openai/gpt-oss-20b` with synthetic sentences: debt creation (both directions after a prompt fix), settlement with a partial amount, debt listing, fixed and variable bill creation, bill payment and the insight question were classified correctly; "Sari aku talangin makan 45rb" produced a clarifying question. Several requests in a burst hit Groq's 8,000 tokens-per-minute limit, which led to the provider chain and the honest rate-limit reply.

**Not verified live:** Telegram inline buttons and callback delivery (requires re-registering the webhook with `callback_query`), debt nudges and bill reminders arriving through the production scheduler, and insight wording on real data.

## Voice notes, goals, habits and meaning search (16 October 2026)

Migration `202610160001_goals_habits_embeddings` adds `Goal`, `Habit`, `HabitLog` (RLS enabled) and `Note.embedding`/`embeddingModel`. 124 tests, lint, strict typecheck, Prettier, the production build and `npm run test:migrations` passed.

Live checks: Groq lists `whisper-large-v3-turbo`; Gemini lists `gemini-embedding-001`. A synthetic clip from an English Windows TTS voice reading Indonesian was transcribed by Groq Whisper (0.9 s) and Gemini (2.6 s); both calls worked, but the wording was poor because of the English voice and the amount came out in words, which led to the number-word parser. Real Indonesian speech has not been tested. Six synthetic notes and queries calibrated the meaning-search threshold (see SETUP_AI). Groq `openai/gpt-oss-20b` classified goal creation (with a deadline), saving, goal progress, habit creation with a check-in time, done and skipped habit reports, and “makan siang lima puluh ribu” correctly after two prompt fixes.

**Not verified live:** voice notes from Telegram, habit check-ins and buttons through the production scheduler, embeddings backfill on the production database, and meaning-search quality on the owner's real notes.
