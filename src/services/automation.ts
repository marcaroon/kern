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
import { billReminders } from "./bills";
import { debtNudges } from "./debts";
import { habitCheckins } from "./habits";
import { embedPendingNotes } from "./semantic";
import { DateTime } from "luxon";
import { AppError, safeCode } from "@/lib/errors";
// The external cron calls tick every minute; ten silent minutes means it stopped.
const staleAfter = 10 * 60 * 1000;
export async function schedulerAlert(
  database: Database,
  now: Date,
  zone: string,
) {
  const tick = await database.heartbeat.findUnique({ where: { name: "tick" } });
  if (tick && now.getTime() - tick.at.getTime() < staleAfter)
    return { alerted: false };
  const owner = ownerId();
  const day = DateTime.fromJSDate(now).setZone(zone).toISODate();
  const since = tick
    ? DateTime.fromJSDate(tick.at)
        .setZone(zone)
        .setLocale("id")
        .toFormat("d LLL HH:mm")
    : null;
  const job = await database.$transaction((tx) =>
    enqueue(
      tx,
      owner,
      `alert:scheduler:${day}`,
      {
        text: [
          `⚠️ Scheduler KERN ${since ? `tidak jalan sejak ${since}` : "belum pernah jalan"}.`,
          "Pengingat, laporan harian, tagihan, check-in kebiasaan dan sinkronisasi Sheets jadi tertunda (Sheets tetap aku coba sinkronkan tiap kamu kirim pesan).",
          "Cek job di cron-job.org: POST /api/internal/tick setiap menit dengan header Authorization Bearer, dan pastikan job-nya tidak nonaktif.",
        ].join("\n"),
      },
      now,
    ),
  );
  return { alerted: job.status === "pending" && job.attempts === 0 };
}
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
        bills: await billReminders(database, now, zone),
        debts: await debtNudges(database, now, zone),
        habits: await habitCheckins(database, now, zone),
        notes: await embedPendingNotes(database),
        messages: await dispatchMessages(database, telegramSender(), now),
      };
    }
    case "reply": {
      // Bound webhook work to one message; the scheduler drains any backlog.
      const inbox = await processInbox(database, now, zone, undefined, 1);
      // The reply goes out before the slower spreadsheet work.
      const messages = await dispatchMessages(
        database,
        telegramSender(),
        now,
        1,
      );
      // New transactions reach Sheets even if the external scheduler stops; a
      // stopped scheduler is reported to the owner at most once a day.
      const sheets = await syncSheets(database, now, undefined, 2).catch(
        (error) => ({ error: safeCode(error) }),
      );
      const scheduler = await schedulerAlert(database, now, zone);
      return {
        inbox,
        messages,
        sheets,
        scheduler,
        alert: scheduler.alerted
          ? await dispatchMessages(database, telegramSender(), now, 1)
          : undefined,
      };
    }
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
          data: { text: "[REDACTED]", fileId: null, fileMime: null },
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
