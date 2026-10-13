import type { Database } from "@/lib/db";
import { AppError, safeCode } from "@/lib/errors";
import { ZodError } from "zod";
import { interpret, type Intent } from "./ai";
import { executeIntent, confirmAction } from "./conversation";
import { enqueue, retryAt } from "./queue";

export async function processInbox(
  database: Database,
  now = new Date(),
  zone = "Asia/Jakarta",
  parser: (
    text: string,
    now: Date,
    zone: string,
  ) => Promise<Intent> = interpret,
) {
  let processed = 0;
  for (let i = 0; i < 10; i++) {
    const didWork = await database.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "InboxMessage" WHERE status IN ('pending','retry') AND "availableAt" <= ${now} ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!rows.length) return false;
        const msg = await tx.inboxMessage.findUniqueOrThrow({
          where: { id: rows[0].id },
        });
        // Serialize owner actions including confirmations without holding locks in the webhook.
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`owner:${msg.ownerId}`}))`;
        await tx.$executeRawUnsafe("SAVEPOINT action_start");
        let reply: string;
        try {
          const confirmation = msg.text
            .trim()
            .match(/^konfirmasi ([0-9a-f-]{36})$/i);
          reply =
            msg.text === "[UNSUPPORTED_MEDIA]"
              ? "Saat ini KERN menerima teks. Voice note dan foto belum didukung."
              : confirmation
                ? await confirmAction(
                    tx,
                    msg.ownerId,
                    confirmation[1],
                    msg.id,
                    now,
                    zone,
                  )
                : await executeIntent(
                    tx,
                    msg.ownerId,
                    await parser(msg.text, now, zone),
                    msg.id,
                    now,
                    zone,
                  );
        } catch (error) {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT action_start");
          if (error instanceof AppError || error instanceof ZodError)
            reply =
              error instanceof AppError
                ? error.message
                : "Data belum lengkap atau tidak valid. Perjelas nominal, judul, tanggal, atau ID. Belum ada perubahan disimpan.";
          else {
            await tx.inboxMessage.update({
              where: { id: msg.id },
              data: {
                status: msg.attempts + 1 >= 5 ? "failed" : "retry",
                attempts: { increment: 1 },
                lastError: safeCode(error),
                availableAt: retryAt(msg.attempts + 1, now),
              },
            });
            return true;
          }
        }
        await enqueue(
          tx,
          msg.ownerId,
          `reply:${msg.id}`,
          {
            text: reply,
            chatId: msg.sender,
          },
          now,
        );
        await tx.inboxMessage.update({
          where: { id: msg.id },
          data: {
            status: "processed",
            processedAt: now,
            attempts: { increment: 1 },
            lastError: null,
          },
        });
        return true;
      },
      { timeout: 45000, maxWait: 5000 },
    );
    if (!didWork) break;
    processed++;
  }
  return { processed };
}
