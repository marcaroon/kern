import type { Database, Tx } from "@/lib/db";
import { AppError, safeCode } from "@/lib/errors";
import { ZodError } from "zod";
import { interpret, type Intent, type Turn } from "./ai";
import { executeIntent, confirmAction, answerProposal } from "./conversation";
import { handleReceiptPhoto, receiptDeps, type ReceiptDeps } from "./receipts";
import { enqueue, retryAt } from "./queue";

export async function processInbox(
  database: Database,
  now = new Date(),
  zone = "Asia/Jakarta",
  parser: (
    text: string,
    now: Date,
    zone: string,
    history: Turn[],
  ) => Promise<Intent> = interpret,
  limit = 10,
  media: ReceiptDeps = receiptDeps,
) {
  let processed = 0;
  for (let i = 0; i < limit; i++) {
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
              ? "Aku bisa membaca teks dan foto nota, tapi belum bisa memproses voice note, video, atau file lain. Kirim dalam bentuk teks atau foto, ya."
              : msg.text === "[IMAGE_TOO_LARGE]"
                ? "Fotonya terlalu besar buat aku baca (maks. 4 MB). Coba kirim sebagai foto biasa, bukan file, ya."
                : msg.fileId
                  ? await handleReceiptPhoto(
                      tx,
                      msg.ownerId,
                      { id: msg.fileId, mime: msg.fileMime || "image/jpeg" },
                      msg.text,
                      now,
                      zone,
                      media,
                    )
                  : confirmation
                    ? await confirmAction(
                        tx,
                        msg.ownerId,
                        confirmation[1],
                        msg.id,
                        now,
                        zone,
                      )
                    : ((await answerProposal(
                        tx,
                        msg.ownerId,
                        msg.text,
                        msg.id,
                        now,
                        zone,
                      )) ??
                      (await executeIntent(
                        tx,
                        msg.ownerId,
                        await parser(
                          msg.text,
                          now,
                          zone,
                          await recentTurns(tx, msg),
                        ),
                        msg.id,
                        now,
                        zone,
                        false,
                        media,
                      )));
        } catch (error) {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT action_start");
          if (error instanceof AppError || error instanceof ZodError)
            reply =
              error instanceof AppError && error.message !== error.code
                ? error.message
                : "Belum bisa aku simpan. Cek lagi nominal, judul, tanggal, atau ID-nya, lalu kirim ulang permintaan lengkapnya, ya. Belum ada yang diubah.";
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

// The last few exchanges of the past 30 minutes, so the assistant can follow up on
// its own questions. Content older than the retention window is already redacted.
async function recentTurns(
  tx: Tx,
  msg: { id: string; ownerId: string; receivedAt: Date },
): Promise<Turn[]> {
  const rows = await tx.inboxMessage.findMany({
    where: {
      ownerId: msg.ownerId,
      id: { not: msg.id },
      status: "processed",
      receivedAt: {
        gte: new Date(msg.receivedAt.getTime() - 30 * 60000),
        lte: msg.receivedAt,
      },
      text: { not: "[REDACTED]" },
    },
    orderBy: { receivedAt: "desc" },
    take: 6,
    select: { id: true, text: true, fileId: true },
  });
  if (!rows.length) return [];
  const replies = await tx.job.findMany({
    where: {
      ownerId: msg.ownerId,
      key: { in: rows.map((r) => `reply:${r.id}`) },
    },
    select: { key: true, payload: true },
  });
  const byKey = new Map(
    replies.map((j) => [j.key, (j.payload as { text?: unknown }).text]),
  );
  return rows.reverse().map((r) => {
    const reply = byKey.get(`reply:${r.id}`);
    return {
      user: r.fileId
        ? `[mengirim foto nota${r.text ? `, caption: ${r.text}` : ""}]`
        : r.text,
      reply: typeof reply === "string" && reply !== "[REDACTED]" ? reply : null,
    };
  });
}
