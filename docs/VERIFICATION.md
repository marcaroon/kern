# Local verification and deployment gate

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
- Fixed a regression from the initial commit: the foreign-currency guard regex contained literal backspace characters instead of `\b`, so a model-returned amount for "10 dolar" was not rejected. A regression test now covers it.

## Dependency caveat

The full development dependency audit reports five high-severity entries in the `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` chain, stemming from an unpatched nested-pattern stack-exhaustion advisory in braces 3.0.3. These are development lint tooling, not production application dependencies. Avoid running tooling on untrusted repository patterns; recheck upstream releases before deployment/build infrastructure accepts untrusted code. Prisma toolchain transitive deepmerge-ts/mysql2 versions are overridden to patched releases and tested by migration/build checks. ESLint 9 is retained for the current Next lint plugins' peer compatibility; update the lint chain together when its plugins support ESLint 10.

## Known product boundaries

One owner, text messages, keyword memory and one action per message. Clarifications require resending the full request. Dashboard timezone is WIB. Missing/uncertain provider deliveries need operator configuration/reconciliation. The managed Sheets tab requires fixed rows. Voice, receipts, Calendar, email and semantic retrieval are roadmap features, not implemented capabilities.
