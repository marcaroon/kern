import type { Database } from "@/lib/db";
import { config, ownerId } from "@/lib/config";
import { processInbox } from "./inbox";
import { materializeReminders } from "./reminders";
import { dispatchMessages, enqueue } from "./queue";
import {
  pollUpdates,
  telegramMode,
  telegramSender,
} from "@/integrations/telegram";
import { syncSheets } from "./sheets";
import { report } from "./reporting";
import { DateTime } from "luxon";
import { AppError, safeCode } from "@/lib/errors";
export async function automate(
  database: Database,
  operation: string,
  now = new Date(),
) {
  const zone = config().TIME_ZONE;
  switch (operation) {
    case "dispatch": {
      // Polling failures must not stop reminders or replies for already stored messages.
      const telegram =
        telegramMode() === "polling"
          ? await pollUpdates(database, ownerId(), fetch, now).catch(
              (error) => ({ error: safeCode(error) }),
            )
          : { mode: "webhook" };
      return {
        telegram,
        inbox: await processInbox(database, now, zone),
        reminders: await materializeReminders(database, now),
        messages: await dispatchMessages(database, telegramSender(), now),
      };
    }
    case "sheets":
      return syncSheets(database, now);
    case "daily":
    case "weekly":
    case "recap": {
      const owner = ownerId(),
        local = DateTime.fromJSDate(now).setZone(zone);
      const key =
        operation === "weekly"
          ? local.startOf("week").toISODate()
          : local.toISODate();
      await database.$transaction(async (tx) => {
        await enqueue(
          tx,
          owner,
          `report:${owner}:${operation}:${key}`,
          {
            text: await report(tx, owner, operation, now, zone),
          },
          now,
        );
      });
      return { queued: true };
    }
    case "maintenance": {
      const cutoff = new Date(
        now.getTime() - config().KERN_LOG_RETENTION_DAYS * 86400000,
      );
      // Retain IDs indefinitely for replay protection; erase conversational content only.
      return database.$transaction(async (tx) => ({
        inbox: await tx.inboxMessage.updateMany({
          where: {
            status: "processed",
            createdAt: { lt: cutoff },
            text: { not: "[REDACTED]" },
          },
          data: { text: "[REDACTED]" },
        }),
        jobs: await tx.job.updateMany({
          where: {
            status: { in: ["cancelled", "accepted"] },
            createdAt: { lt: cutoff },
          },
          data: { payload: { text: "[REDACTED]" } },
        }),
        confirmations: await tx.pendingAction.deleteMany({
          where: { expiresAt: { lt: cutoff } },
        }),
      }));
    }
    default:
      throw new AppError("NOT_FOUND", 404);
  }
}
