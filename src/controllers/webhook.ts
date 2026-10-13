import { boundary, respond, AppError } from "@/lib/errors";
import { constantEqual, bodyJson, rateLimit } from "@/lib/security";
import { db } from "@/lib/db";
import { ownerId, allowedTelegramIds } from "@/lib/config";
import { ingestUpdates, telegramMode } from "@/integrations/telegram";
// Optional hosted mode. Local installs poll getUpdates from the worker instead.
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
    return respond(
      await ingestUpdates(
        db(),
        [await bodyJson(request)],
        ownerId(),
        allowedTelegramIds(),
      ),
    );
  });
}
