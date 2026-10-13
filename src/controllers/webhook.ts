import { boundary, respond, AppError, safeCode } from "@/lib/errors";
import { constantEqual, bodyJson, rateLimit } from "@/lib/security";
import { db } from "@/lib/db";
import { ownerId, allowedTelegramIds } from "@/lib/config";
import {
  ingestUpdates,
  setupReplies,
  telegramMode,
} from "@/integrations/telegram";
import { automate } from "@/services/automation";
// Hosted mode. Local installs poll getUpdates from the worker instead.
export function receiveTelegram(request: Request) {
  return boundary(async () => {
    if (telegramMode() !== "webhook") throw new AppError("NOT_FOUND", 404);
    rateLimit("webhook", 300);
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
    if (
      secret.length < 32 ||
      !constantEqual(
        request.headers.get("x-telegram-bot-api-secret-token") || "",
        secret,
      )
    )
      throw new AppError("INVALID_WEBHOOK_SECRET", 401);
    const database = db();
    const update = await bodyJson(request);
    const result = await ingestUpdates(
      database,
      [update],
      ownerId(),
      allowedTelegramIds(),
    );
    await setupReplies([update], allowedTelegramIds());
    // The message is durably stored; a processing failure is retried by the
    // scheduled dispatch, so Telegram still receives success and does not resend.
    if (result.accepted)
      await automate(database, "reply").catch((error) =>
        console.error(
          JSON.stringify({
            event: "webhook_reply_failed",
            code: safeCode(error),
          }),
        ),
      );
    return respond(result);
  });
}
