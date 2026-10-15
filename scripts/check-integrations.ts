import "dotenv/config";
import { configured, required, allowedTelegramIds } from "../src/lib/config";
import { db } from "../src/lib/db";
import { googleSheet, sheetHeaders } from "../src/integrations/sheets";
import { telegramMode } from "../src/integrations/telegram";
import { aiProvider } from "../src/services/ai";
import { AppError, safeCode } from "../src/lib/errors";

// Read-only diagnostics: never print URLs, credentials, user content or provider errors.
async function check(name: string, run: () => Promise<string>) {
  try {
    console.log(`${name}: ${await run()}`);
  } catch (error) {
    console.log(
      `${name}: ${safeCode(error)} (check credentials, permissions and connectivity)`,
    );
    process.exitCode = 1;
  }
}
async function telegram(method: string) {
  const response = await fetch(
    `https://api.telegram.org/bot${required("TELEGRAM_BOT_TOKEN")}/${method}`,
    {
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.ok)
    throw new AppError(`TELEGRAM_HTTP_${response.status}`);
  return body.result;
}
await check("Database", async () => {
  if (!configured("DATABASE_URL")) return "NOT_CONFIGURED";
  try {
    await db().$queryRaw`SELECT 1`;
    return "CONNECTED (read-only)";
  } finally {
    await db().$disconnect();
  }
});
await check("Groq", async () => {
  if (!configured("GROQ_API_KEY", "GROQ_MODEL")) return "NOT_CONFIGURED";
  const response = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${required("GROQ_API_KEY")}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("UNAVAILABLE");
  const body = await response.json();
  if (
    !body.data?.some(
      (model: { id: string }) => model.id === required("GROQ_MODEL"),
    )
  )
    throw new Error("MODEL_UNAVAILABLE");
  return `MODEL_AVAILABLE; ${aiProvider() === "groq" ? "SELECTED" : "NOT_SELECTED"}; inference not tested`;
});
await check("Telegram", async () => {
  if (!configured("TELEGRAM_BOT_TOKEN")) return "NOT_CONFIGURED";
  await telegram("getMe");
  const info = await telegram("getWebhookInfo");
  const mode = info.url ? "webhook" : "polling";
  if (mode !== telegramMode())
    throw new AppError(`TELEGRAM_MODE_MISMATCH_REMOTE_${mode.toUpperCase()}`);
  return `CONNECTED (${mode}); allowlist ${allowedTelegramIds().length ? "configured" : "missing"}; pending ${Number(info.pending_update_count || 0)}; historical webhook error ${Boolean(info.last_error_date)}; delivery not tested`;
});
await check("Sheets", async () => {
  if (
    !configured("GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON")
  )
    return "NOT_CONFIGURED";
  const headers = (await googleSheet().read("Transactions!A1:L1"))[0];
  if (JSON.stringify(headers) !== JSON.stringify(sheetHeaders))
    throw new Error("HEADERS_MISMATCH");
  return "READ_VERIFIED; headers valid; write permission not tested";
});
