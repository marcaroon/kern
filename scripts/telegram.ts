import "dotenv/config";
// Telegram setup helper. Prints no tokens or message text.
//   npm run telegram -- id        show user IDs that messaged the bot (does not consume updates)
//   npm run telegram -- webhook   register https://<NEXT_PUBLIC_APP_URL>/api/webhooks/telegram
//   npm run telegram -- polling   remove the webhook so `npm run worker` can poll
//   npm run telegram -- status    show the current webhook state
const command = process.argv[2];
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in .env first.");
async function call(method: string, body: Record<string, unknown> = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    },
  );
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  };
  if (!data.ok)
    throw new Error(`Telegram ${method} failed (HTTP ${response.status}).`);
  return data.result;
}
if (command === "id") {
  const updates = (await call("getUpdates", { timeout: 0 })) as {
    message?: {
      chat: { type: string };
      from?: { id: number; is_bot: boolean; first_name?: string };
    };
  }[];
  const people = new Map<number, string>();
  for (const u of updates)
    if (
      u.message?.chat.type === "private" &&
      u.message.from &&
      !u.message.from.is_bot
    )
      people.set(u.message.from.id, u.message.from.first_name || "");
  if (!people.size)
    console.log(
      "No private messages pending. Send /start to the bot, then run this again (works only in polling mode).",
    );
  for (const [id, name] of people) console.log(`${id}  ${name}`);
  console.log("Put your ID in TELEGRAM_OWNER_USER_ID.");
} else if (command === "webhook") {
  const base = process.env.NEXT_PUBLIC_APP_URL || "";
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (!base.startsWith("https://"))
    throw new Error("NEXT_PUBLIC_APP_URL must be the public https URL.");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret))
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must be 32-256 characters of A-Z a-z 0-9 _ -.",
    );
  await call("setWebhook", {
    url: `${base.replace(/\/$/, "")}/api/webhooks/telegram`,
    secret_token: secret,
    allowed_updates: ["message"],
    max_connections: 10,
  });
  console.log("Webhook registered. Use TELEGRAM_MODE=webhook on the server.");
} else if (command === "polling") {
  await call("deleteWebhook", { drop_pending_updates: false });
  console.log(
    "Webhook removed. Use TELEGRAM_MODE=polling and run `npm run worker`.",
  );
} else if (command === "status") {
  const info = (await call("getWebhookInfo")) as {
    url?: string;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
  };
  console.log(
    JSON.stringify(
      {
        mode: info.url ? "webhook" : "polling",
        url: info.url || null,
        pending: info.pending_update_count ?? 0,
        lastError: info.last_error_date
          ? `${new Date(info.last_error_date * 1000).toISOString()} ${info.last_error_message ?? ""}`
          : null,
      },
      null,
      1,
    ),
  );
} else {
  console.log("Usage: npm run telegram -- id | webhook | polling | status");
}
