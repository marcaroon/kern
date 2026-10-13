# n8n workflows

Import the JSON files in `n8n/workflows` using n8n's Import from File. All workflows are inactive and contain no credentials. Each has a Schedule Trigger and an authenticated HTTP Request to KERN; business logic stays in backend services.

Create a random KERN_INTERNAL_API_SECRET of at least 32 characters and store it in the backend environment. Create an n8n **Header Auth** credential: Name `Authorization`, Value `Bearer YOUR_SECRET`. Select this credential in each Call KERN node. Do not paste secrets into exported workflow JSON. Configure the n8n variable KERN_BASE_URL to the reachable HTTPS origin, without a trailing slash. If your n8n edition has no variables, replace the URL expression with a literal non-secret base URL. For local testing, the n8n host must be able to reach your app; localhost inside a container points to that container, not the host.

| File             | Endpoint                       | Default schedule (Asia/Jakarta)                                     |
| ---------------- | ------------------------------ | ------------------------------------------------------------------- |
| dispatch.json    | POST /api/internal/dispatch    | Every minute: inbox, reminder materialization and outbound delivery |
| daily.json       | POST /api/internal/daily       | Daily 07:00                                                         |
| weekly.json      | POST /api/internal/weekly      | Sunday 20:00                                                        |
| sheets.json      | POST /api/internal/sheets      | Every minute                                                        |
| maintenance.json | POST /api/internal/maintenance | Daily 03:00; redact old conversation content                        |
| recap.json       | POST /api/internal/recap       | Optional daily 21:00                                                |

Workflow timezone is explicitly Asia/Jakarta. To change schedules, edit Schedule Trigger and republish/activate. KERN_DAILY_BRIEFING_TIME and KERN_WEEKLY_REVIEW_* in .env.example document desired values; **they do not dynamically change imported n8n schedules**. Change both the documented values and the trigger configuration. Endpoint timeouts need to accommodate bounded batches (HTTP Request is configured for 300 seconds); choose a compatible Node host. Never expose the internal secret to browsers.

After import, select credentials, manually execute each workflow, inspect HTTP response, then activate. Check that running daily/weekly twice creates only one report job for that period. Run dispatch afterward to send queued reports. Report content is generated entirely from recorded facts and labels incomplete data clearly. Telegram truncates messages above 4096 characters; the dashboard and report endpoint retain full report text.

Recovery: queue state lives in PostgreSQL, not n8n. Restarting n8n keeps pending reminders and sync work. Reminder dispatch catches up once per reminder and advances its next schedule. Failed/blocked sends require the dashboard's retry after fixing credentials/policy; uncertain jobs require checking the Telegram chat first. With n8n driving dispatch, the dispatch call also polls Telegram unless TELEGRAM_MODE=webhook. Missed scheduled reports are not automatically backfilled; execute the desired report endpoint once for the current period. Restrict stored n8n execution data/retention and credential access.

Local alternative: `npm run worker` processes core queues without n8n. It does not schedule daily/weekly briefings. Avoid running unnecessary duplicate schedulers, even though database claims/deduplication protect actions.

Official references: [Schedule Trigger and timezone](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/), [HTTP Request node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/).
