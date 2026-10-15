import type { Tx, Database } from "@/lib/db";
import { json } from "@/lib/db";
import { z } from "zod";
import { safeCode, AppError } from "@/lib/errors";
export const outboundPayload = z.object({
  text: z.string(),
  chatId: z.string().optional(),
  reminderId: z.string().optional(),
  generation: z.number().optional(),
  occurrenceAt: z.string().optional(),
  // Telegram inline keyboard rows; data is a short action such as "ok:<uuid>".
  buttons: z
    .array(
      z.array(
        z.object({
          text: z.string().max(40),
          data: z.string().regex(/^[a-z]+:[0-9a-f-]{36}$/),
        }),
      ),
    )
    .optional(),
});
export type Outbound = z.infer<typeof outboundPayload>;
export async function enqueue(
  tx: Tx,
  ownerId: string,
  key: string,
  payload: Outbound,
  now = new Date(),
) {
  return tx.job.upsert({
    where: { key },
    create: {
      ownerId,
      key,
      kind: "message",
      payload: json(payload),
      availableAt: now,
    },
    update: {},
  });
}
export class DeliveryError extends AppError {
  constructor(
    code: string,
    public disposition: "retry" | "blocked" | "uncertain" | "failed",
  ) {
    super(code, 503);
  }
}
export function retryAt(attempts: number, now: Date) {
  return new Date(
    now.getTime() + Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1)) * 1000,
  );
}
export async function dispatchMessages(
  database: Database,
  send: (payload: Outbound, ownerId: string, now: Date) => Promise<string>,
  now = new Date(),
  limit = 30,
) {
  // A crashed send may already have reached Telegram. Never automatically resend it.
  await database.job.updateMany({
    where: {
      status: "processing",
      claimedAt: { lt: new Date(now.getTime() - 120000) },
    },
    data: { status: "uncertain", lastError: "WORKER_INTERRUPTED_CHECK_CHAT" },
  });
  const jobs = await database.job.findMany({
    where: {
      kind: "message",
      status: { in: ["pending", "retry"] },
      availableAt: { lte: now },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let processed = 0;
  for (const job of jobs) {
    const claim = await database.job.updateMany({
      where: { id: job.id, status: job.status, attempts: job.attempts },
      data: {
        status: "processing",
        claimedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (!claim.count) continue;
    const payload = outboundPayload.parse(job.payload);
    let providerId: string;
    try {
      if (payload.reminderId) {
        const reminder = await database.reminder.findFirst({
          where: { id: payload.reminderId, ownerId: job.ownerId },
        });
        if (
          !reminder ||
          reminder.status === "cancelled" ||
          reminder.generation !== payload.generation
        ) {
          await database.job.update({
            where: { id: job.id },
            data: { status: "cancelled" },
          });
          continue;
        }
      }
      providerId = await send(payload, job.ownerId, now);
    } catch (error) {
      const disposition =
        error instanceof DeliveryError ? error.disposition : "uncertain";
      const status =
        disposition === "retry" && job.attempts + 1 >= 5
          ? "failed"
          : disposition;
      const code = safeCode(error);
      await database.$transaction(async (tx) => {
        await tx.job.update({
          where: { id: job.id },
          data: {
            status,
            lastError: code,
            availableAt: retryAt(job.attempts + 1, now),
          },
        });
        if (payload.reminderId)
          await tx.reminder.updateMany({
            where: {
              id: payload.reminderId,
              generation: payload.generation,
              lastOccurrenceAt: payload.occurrenceAt,
            },
            data: { deliveryStatus: status, lastError: code },
          });
      });
      continue;
    }
    // Keep this outside the send catch: failed persistence must never become a retry.
    await database.$transaction(async (tx) => {
      await tx.job.update({
        where: { id: job.id },
        data: { providerId, status: "accepted", lastError: null },
      });
      if (payload.reminderId)
        await tx.reminder.updateMany({
          where: {
            id: payload.reminderId,
            generation: payload.generation,
            lastOccurrenceAt: payload.occurrenceAt,
          },
          data: { deliveryStatus: "accepted", lastError: null },
        });
    });
    processed++;
  }
  return { processed };
}
