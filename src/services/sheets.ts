import type { Database } from "@/lib/db";
import { safeCode } from "@/lib/errors";
import { configured } from "@/lib/config";
import {
  googleSheet,
  upsertSheetRow,
  type SheetPort,
} from "@/integrations/sheets";
import { retryAt } from "./queue";
export async function syncSheets(
  database: Database,
  now = new Date(),
  sheet?: SheetPort,
) {
  if (
    !sheet &&
    !configured("GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON")
  )
    return { status: "not_configured", processed: 0 };
  const port = sheet || googleSheet();
  let processed = 0;
  for (let i = 0; i < 20; i++) {
    const worked = await database.$transaction(
      async (tx) => {
        // One writer per managed worksheet, including revisions of the same transaction.
        const [lock] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(17481932) AS locked`;
        if (!lock.locked) return false;
        const event = await tx.sheetSyncOutbox.findFirst({
          where: {
            status: { in: ["pending", "retry"] },
            availableAt: { lte: now },
          },
          orderBy: { createdAt: "asc" },
          include: {
            transaction: { include: { account: true, toAccount: true } },
          },
        });
        if (!event) return false;
        try {
          await upsertSheetRow(port, event.transaction);
          await tx.sheetSyncOutbox.updateMany({
            where: {
              transactionId: event.transactionId,
              revision: { lte: event.transaction.revision },
              status: { not: "synced" },
            },
            data: { status: "synced", lastError: null },
          });
        } catch (error) {
          await tx.sheetSyncOutbox.update({
            where: { id: event.id },
            data: {
              status: event.attempts + 1 >= 5 ? "failed" : "retry",
              attempts: { increment: 1 },
              lastError: safeCode(error),
              availableAt: retryAt(event.attempts + 1, now),
            },
          });
        }
        return true;
      },
      { timeout: 90000 },
    );
    if (!worked) break;
    processed++;
  }
  return { status: "processed", processed };
}
