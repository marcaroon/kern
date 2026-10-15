import type { Tx } from "@/lib/db";
import { json } from "@/lib/db";

// One live proposal per owner: a new one supersedes older ones, so a plain "ya" or
// "batal" always refers to the most recent question KERN asked.
export async function propose(
  tx: Tx,
  ownerId: string,
  payload: Record<string, unknown>,
  now: Date,
  minutes = 10,
) {
  await tx.pendingAction.updateMany({
    where: { ownerId, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  return tx.pendingAction.create({
    data: {
      ownerId,
      payload: json(payload),
      expiresAt: new Date(now.getTime() + minutes * 60000),
    },
  });
}
export function latestPending(tx: Tx, ownerId: string, now: Date) {
  return tx.pendingAction.findFirst({
    where: { ownerId, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
}
