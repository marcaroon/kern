# Telegram Bot API

KERN uses the official [Telegram Bot API](https://core.telegram.org/bots/api). There is no business verification, template approval, service window or per-message fee.

## Create the bot

1. In Telegram, open **@BotFather**, send `/newbot`, choose a display name and a username ending in `bot`.
2. Put the token in `.env` as `TELEGRAM_BOT_TOKEN`. Treat it like a password; anyone with it controls the bot. Revoke it with `/revoke` in BotFather if it leaks.
3. Open your bot and press **Start** (a bot cannot message a user who never started it).
4. Find your numeric Telegram user ID (for example from the `from.id` of your `/start` update) and set `TELEGRAM_OWNER_USER_ID`. A comma-separated allowlist is supported; the first ID receives reports and reminders. Usernames and phone numbers are not used for authorization.

Only private chats from an allowlisted, non-bot user enter the inbox. Group messages, other users and bots are ignored without storing content.

## Receiving messages

**Polling (default, `TELEGRAM_MODE=polling`)**: `npm run worker` calls `getUpdates` every cycle. No public URL, tunnel or webhook is needed. Updates are confirmed (next `offset`) only after they are committed to the inbox, so a crash redelivers them and the stable inbox ID `tg:<chat>:<message_id>` prevents duplicate actions. Polling fails with `TELEGRAM_WEBHOOK_ACTIVE` while a webhook is registered; remove it with `deleteWebhook`.

**Webhook (optional, for hosted deployments, `TELEGRAM_MODE=webhook`)**: set `TELEGRAM_WEBHOOK_SECRET` (at least 32 random characters, letters/digits/`_`/`-`) and register `https://YOUR_HOST/api/webhooks/telegram` with `setWebhook` including the same `secret_token`. KERN compares the `X-Telegram-Bot-Api-Secret-Token` header in constant time before reading the body. In polling mode the route answers 404.

## Keep the worker running on Windows

The bot answers only while the worker runs. To start it automatically and hidden at every logon:

```powershell
.\scripts\windows\install-worker-task.ps1             # install, or restart after changes
.\scripts\windows\install-worker-task.ps1 -Uninstall  # stop and remove
```

This registers the per-user scheduled task "KERN Worker" (single instance, no elevated rights). `scripts/windows/run-worker.ps1` restarts the worker 15 seconds after any exit and writes to `.local/worker.log` (rotated at 5 MB). Do not also run `npm run worker` in a terminal while the task is active: two pollers make Telegram reject `getUpdates` with a conflict. After changing `.env` or the code, rerun the installer: it stops the running worker (including its node processes) and starts a fresh one. Messages sent while the PC is off are kept by Telegram for up to 24 hours and processed when the worker starts.

## Sending and statuses

Replies go to the chat that sent the message; reports and reminders go to the first allowlisted ID. Text longer than 4096 characters is truncated; the dashboard and report endpoint keep the full text.

`accepted` means Telegram accepted `sendMessage`. The Bot API provides no delivery or read receipts, so KERN never marks a message `delivered`. HTTP 429 retries with bounded backoff (five attempts). 400/401/403/404 become `blocked` (invalid token, bot blocked by the owner, unknown chat). Timeouts and 5xx become `uncertain`: check the chat before retrying from Integrasi, because a retry may duplicate the message.

## First end-to-end test

1. Start `npm run dev` and `npm run worker`. Note the current transaction count.
2. Send the bot: **Catat pengeluaran 35 ribu buat makan siang QRIS.** (works without an AI key).
3. Within one worker cycle expect a reply with Rp35.000, Makan & Minum, QRIS and an ID. Transaksi shows exactly one new expense of 35000 with source `telegram`.
4. Send `Ingatkan gue besok jam 9 pagi buat follow up vendor.` and verify the WIB time; schedule a reminder a few minutes ahead from the dashboard to test proactive delivery.
5. Message the bot from another Telegram account: nothing is stored.

Automated tests mock the Telegram API and never contact it.
