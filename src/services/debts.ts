import { z } from "zod";
import { DateTime } from "luxon";
import type { Database, Tx } from "@/lib/db";
import { audit } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { money } from "@/lib/validation";
import { rupiah } from "./finance";
import { enqueue } from "./queue";

export const debtInput = z
  .object({
    person: z.string().trim().min(1).max(60),
    direction: z.enum(["owed_to_me", "i_owe"]),
    amount: money,
    description: z.string().trim().min(1).max(200),
  })
  .strict();
export type DebtInput = z.infer<typeof debtInput>;
// Reminders to collect or repay: after 3 days, then every 4 days, at most 3 times.
const firstNudgeDays = 3;
const nudgeEveryDays = 4;
const maxNudges = 3;

export async function saveDebt(
  tx: Tx,
  ownerId: string,
  input: unknown,
  now: Date,
) {
  const parsed = debtInput.parse(input);
  // Reuse the spelling already on record, so "budi" and "Budi" are one person.
  const known = await tx.debt.findFirst({
    where: {
      ownerId,
      person: { equals: parsed.person, mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    select: { person: true },
  });
  const row = await tx.debt.create({
    data: {
      ownerId,
      person: known?.person ?? parsed.person,
      direction: parsed.direction,
      amount: BigInt(parsed.amount),
      description: parsed.description,
      createdAt: now,
      nextNudgeAt: new Date(now.getTime() + firstNudgeDays * 86400000),
    },
  });
  await audit(tx, ownerId, "debt.create", row.id, null, row);
  return row;
}
export const remaining = (d: { amount: bigint; paid: bigint }) =>
  d.amount - d.paid;
function openDebts(
  tx: Tx,
  ownerId: string,
  where: { person?: string; direction?: string | null; id?: string },
) {
  return tx.debt.findMany({
    where: {
      ownerId,
      status: "open",
      ...(where.id ? { id: where.id } : {}),
      ...(where.person
        ? { person: { equals: where.person.trim(), mode: "insensitive" } }
        : {}),
      ...(where.direction ? { direction: where.direction } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
}
// Applies a payment to the oldest open debts first. Without an amount, everything
// open for that person and direction is settled.
export async function settleDebts(
  tx: Tx,
  ownerId: string,
  target: {
    id?: string;
    person?: string | null;
    direction?: string | null;
    amount?: string | null;
  },
  now: Date,
) {
  if (!target.id && !target.person)
    throw new AppError("DEBT_PERSON_REQUIRED", 422, "Utang siapa yang lunas?");
  const rows = await openDebts(tx, ownerId, {
    id: target.id,
    person: target.person ?? undefined,
    direction: target.direction,
  });
  if (!rows.length)
    throw new AppError(
      "DEBT_NOT_FOUND",
      404,
      target.id
        ? "Utang ini sudah lunas atau sudah dihapus."
        : `Aku nggak menemukan utang yang masih terbuka dengan ${target.person}.`,
    );
  if (new Set(rows.map((r) => r.direction)).size > 1)
    throw new AppError(
      "DEBT_DIRECTION_AMBIGUOUS",
      422,
      `Kamu dan ${rows[0].person} sama-sama punya utang. Maksudnya ${rows[0].person} yang bayar ke kamu, atau kamu yang bayar ke ${rows[0].person}?`,
    );
  const open = rows.reduce((sum, r) => sum + remaining(r), 0n);
  let left = target.amount ? BigInt(money.parse(target.amount)) : open;
  if (left > open)
    throw new AppError(
      "DEBT_OVERPAID",
      422,
      `Sisa utangnya cuma ${rupiah(open)}, lebih kecil dari ${rupiah(left)}. Cek lagi nominalnya, ya.`,
    );
  const paid = left;
  for (const row of rows) {
    if (left <= 0n) break;
    const part = left < remaining(row) ? left : remaining(row);
    left -= part;
    const settled = part === remaining(row);
    const updated = await tx.debt.update({
      where: { id: row.id },
      data: {
        paid: { increment: part },
        ...(settled
          ? { status: "settled", settledAt: now, nextNudgeAt: null }
          : {}),
      },
    });
    await audit(tx, ownerId, "debt.settle", row.id, row, updated);
  }
  return {
    person: rows[0].person,
    direction: rows[0].direction,
    paid,
    left: open - paid,
  };
}
export function settledText(result: Awaited<ReturnType<typeof settleDebts>>) {
  const who =
    result.direction === "owed_to_me"
      ? `${result.person} sudah bayar ${rupiah(result.paid)} ke kamu`
      : `Kamu sudah bayar ${rupiah(result.paid)} ke ${result.person}`;
  return result.left > 0n
    ? `✅ Dicatat: ${who}. Sisa utangnya ${rupiah(result.left)}.`
    : `✅ Lunas! ${who}. Nggak ada sisa utang lagi.`;
}
export async function listDebts(
  tx: Tx,
  ownerId: string,
  direction: string | null,
  now: Date,
) {
  const rows = await openDebts(tx, ownerId, { direction });
  if (!rows.length)
    return direction === "i_owe"
      ? "Kamu nggak punya utang yang tercatat. Mantap 👍"
      : direction === "owed_to_me"
        ? "Nggak ada yang punya utang ke kamu saat ini."
        : "Belum ada utang-piutang yang terbuka.";
  const section = (dir: string, title: string) => {
    const list = rows.filter((r) => r.direction === dir);
    if (!list.length) return [];
    const total = list.reduce((s, r) => s + remaining(r), 0n);
    return [
      `${title} (${rupiah(total)}):`,
      ...list.map(
        (r) =>
          `• ${r.person}: ${rupiah(remaining(r))} — ${r.description} (${age(r.createdAt, now)})`,
      ),
    ];
  };
  return [
    ...section("owed_to_me", "💰 Yang masih utang ke kamu"),
    ...(rows.some((r) => r.direction === "owed_to_me") &&
    rows.some((r) => r.direction === "i_owe")
      ? [""]
      : []),
    ...section("i_owe", "💸 Utangmu"),
    "",
    "Kalau sudah dibayar, bilang aja misalnya “Budi udah bayar”.",
  ].join("\n");
}
function age(from: Date, now: Date) {
  const days = Math.floor((now.getTime() - from.getTime()) / 86400000);
  return days < 1 ? "hari ini" : `${days} hari lalu`;
}
export function debtSummary(
  rows: { direction: string; amount: bigint; paid: bigint }[],
) {
  let owedToMe = 0n,
    iOwe = 0n;
  for (const r of rows)
    if (r.direction === "owed_to_me") owedToMe += remaining(r);
    else iOwe += remaining(r);
  return { owedToMe, iOwe };
}
// Proactive reminders with a one-tap "lunas" button. Job keys make them idempotent.
export async function debtNudges(database: Database, now: Date, zone: string) {
  return database.$transaction(async (tx) => {
    const due = await tx.debt.findMany({
      where: {
        status: "open",
        nudges: { lt: maxNudges },
        nextNudgeAt: { lte: now },
      },
      take: 50,
    });
    for (const d of due) {
      const since = DateTime.fromJSDate(d.createdAt)
        .setZone(zone)
        .setLocale("id")
        .toFormat("d LLL");
      const text =
        d.direction === "owed_to_me"
          ? [
              `👋 ${d.person} masih punya utang ${rupiah(remaining(d))} ke kamu (${d.description}, sejak ${since}).`,
              `Mau nagih? Ini teks yang bisa kamu teruskan:`,
              `“Hai ${d.person}, yang ${d.description} kemarin ${rupiah(remaining(d))} ya, makasih 🙏”`,
            ].join("\n")
          : `👋 Pengingat: kamu masih punya utang ${rupiah(remaining(d))} ke ${d.person} (${d.description}, sejak ${since}).`;
      await enqueue(
        tx,
        d.ownerId,
        `debt:${d.id}:${d.nudges}`,
        {
          text,
          buttons: [[{ text: "✅ Udah lunas", data: `settle:${d.id}` }]],
        },
        now,
      );
      await tx.debt.update({
        where: { id: d.id },
        data: {
          nudges: { increment: 1 },
          nextNudgeAt:
            d.nudges + 1 >= maxNudges
              ? null
              : new Date(now.getTime() + nudgeEveryDays * 86400000),
        },
      });
    }
    return { queued: due.length };
  });
}
