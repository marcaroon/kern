import type { Database } from "@/lib/db";
import { allowedTelegramIds, configured } from "@/lib/config";
import { telegramMode } from "@/integrations/telegram";
import { aiProvider } from "@/services/ai";
export async function integrationHealth(database: Database, ownerId: string) {
  await database.$queryRaw`SELECT 1`;
  const [jobs, sync, inbox] = await Promise.all([
    database.job.findMany({
      where: { ownerId },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        attempts: true,
        lastError: true,
        updatedAt: true,
        providerId: true,
      },
    }),
    database.sheetSyncOutbox.findMany({
      where: { ownerId, status: { not: "synced" } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    database.inboxMessage.findMany({
      where: { ownerId, status: { not: "processed" } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, status: true, attempts: true, lastError: true },
    }),
  ]);
  const tick = await database.heartbeat.findUnique({ where: { name: "tick" } });
  // The external cron calls tick every minute; allow for a couple of missed runs.
  const schedulerRunning =
    !!tick && Date.now() - tick.at.getTime() < 3 * 60 * 1000;
  return {
    database: "connected",
    schedulerLastRunAt: tick?.at ?? null,
    integrations: {
      scheduler: schedulerRunning ? "berjalan" : false,
      telegram:
        configured("TELEGRAM_BOT_TOKEN") && allowedTelegramIds().length > 0
          ? telegramMode()
          : false,
      ai: aiProvider(),
      sheets: configured(
        "GOOGLE_SHEETS_SPREADSHEET_ID",
        "GOOGLE_SERVICE_ACCOUNT_JSON",
      ),
      automation: configured("KERN_INTERNAL_API_SECRET"),
    },
    jobs,
    sync,
    inbox,
    note: "Konfigurasi tersedia bukan bukti koneksi atau pengiriman berhasil.",
  };
}
