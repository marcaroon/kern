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
    case "reply":
      // Webhook mode: answer stored messages within the same request (no resident worker).
      return {
        inbox: await processInbox(database, now, zone),
        messages: await dispatchMessages(database, telegramSender(), now),
      };
    case "tick": {
      // One external per-minute scheduler call drives everything on serverless hosts.
      // Reports run in a window so a late or skipped minute still fires once; their
      // job keys are per period, so repeated calls inside the window enqueue nothing new.
      const c = config(),
        local = DateTime.fromJSDate(now).setZone(zone);
      const inWindow = (time: string) => {
        const [hour, minute] = time.split(":").map(Number);
        const minutes = local
          .diff(local.set({ hour, minute, second: 0, millisecond: 0 }))
          .as("minutes");
        return minutes >= 0 && minutes < 15;
      };
      const step = (op: string) =>
        automate(database, op, now).catch((error) => ({
          error: safeCode(error),
        }));
      const result: Record<string, unknown> = {};
      if (inWindow(c.KERN_DAILY_BRIEFING_TIME))
        result.daily = await step("daily");
      if (
        local.setLocale("en").weekdayLong?.toUpperCase() ===
          c.KERN_WEEKLY_REVIEW_DAY &&
        inWindow(c.KERN_WEEKLY_REVIEW_TIME)
      )
        result.weekly = await step("weekly");
      if (inWindow("03:00")) result.maintenance = await step("maintenance");
      result.dispatch = await step("dispatch");
      result.sheets = await step("sheets");
      // Lets the dashboard show whether the external scheduler is actually running.
      await database.heartbeat.upsert({
        where: { name: "tick" },
        create: { name: "tick", at: now },
        update: { at: now },
      });
      return result;
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
