import { z } from "zod";
import { DateTime } from "luxon";
import type { Database, Tx } from "@/lib/db";
import { audit } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { money } from "@/lib/validation";
import {
  categoryLabel,
  expenseCategories,
  rupiah,
  saveTransaction,
} from "./finance";
import { enqueue } from "./queue";

export const billInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    amount: money.nullable(),
    dueDay: z.number().int().min(1).max(31),
    category: z.string().trim().min(1).max(80).default("bills"),
    paymentMethod: z.string().trim().max(80).nullable().optional(),
  })
  .strict();
// Reminders go out at 09:00 local time, 3 days before, on the day and 2 days late.
const reminderHour = 9;
const soonDays = 3;
const lateDays = 2;

// The due moment in a given month; day 31 becomes the last day of shorter months.
export function dueIn(month: DateTime, dueDay: number) {
  const start = month.startOf("month");
  return start.set({
    day: Math.min(dueDay, start.daysInMonth!),
    hour: reminderHour,
  });
}
// The first due date that is today or later.
export function firstDue(dueDay: number, now: Date, zone: string) {
  const local = DateTime.fromJSDate(now).setZone(zone);
  const thisMonth = dueIn(local, dueDay);
  return (
    thisMonth.startOf("day") >= local.startOf("day")
      ? thisMonth
      : dueIn(local.plus({ months: 1 }), dueDay)
  ).toJSDate();
}
const dayMonth = (date: Date, zone: string) =>
  DateTime.fromJSDate(date).setZone(zone).setLocale("id").toFormat("d LLL");
const amountText = (amount: bigint | null) =>
  amount ? rupiah(amount) : "nominal menyesuaikan";

function activeBill(tx: Tx, ownerId: string, name: string) {
  return tx.bill.findFirst({
    where: {
      ownerId,
      status: "active",
      name: { equals: name.trim(), mode: "insensitive" },
    },
  });
}
// A bill with the same name is updated rather than duplicated.
export async function saveBill(
  tx: Tx,
  ownerId: string,
  input: unknown,
  now: Date,
  zone: string,
) {
  const parsed = billInput.parse(input);
  const category = expenseCategories.includes(parsed.category)
    ? parsed.category
    : "bills";
  const data = {
    name: parsed.name,
    amount: parsed.amount ? BigInt(parsed.amount) : null,
    category,
    paymentMethod: parsed.paymentMethod ?? null,
    dueDay: parsed.dueDay,
    nextDueAt: firstDue(parsed.dueDay, now, zone),
  };
  const before = await activeBill(tx, ownerId, parsed.name);
  const row = before
    ? await tx.bill.update({ where: { id: before.id }, data })
    : await tx.bill.create({ data: { ...data, ownerId } });
  await audit(
    tx,
    ownerId,
    before ? "bill.update" : "bill.create",
    row.id,
    before,
    row,
  );
  return { row, updated: Boolean(before) };
}
export function billSavedText(
  result: Awaited<ReturnType<typeof saveBill>>,
  zone: string,
) {
  const b = result.row;
  return [
    `🔔 ${result.updated ? "Sudah aku perbarui" : "Siap, aku catat"}: tagihan ${b.name} ${amountText(b.amount)}, tiap tanggal ${b.dueDay}.`,
    `Aku ingatkan 3 hari sebelumnya dan pas hari H (berikutnya ${dayMonth(b.nextDueAt, zone)}). Tinggal tekan “Udah bayar”, nanti otomatis tercatat sebagai pengeluaran ${categoryLabel(b.category)}.`,
  ].join("\n");
}
async function findBill(
  tx: Tx,
  ownerId: string,
  target: { id?: string; name?: string | null },
) {
  let row = target.id
    ? await tx.bill.findFirst({
        where: { id: target.id, ownerId, status: "active" },
      })
    : target.name
      ? await activeBill(tx, ownerId, target.name)
      : null;
  // "bayar internet" also finds "Internet Indihome" when it is the only match.
  if (!row && !target.id && target.name) {
    const similar = await tx.bill.findMany({
      where: {
        ownerId,
        status: "active",
        name: { contains: target.name.trim(), mode: "insensitive" },
      },
      take: 2,
    });
    if (similar.length === 1) row = similar[0];
  }
  if (!row)
    throw new AppError(
      "BILL_NOT_FOUND",
      404,
      target.name
        ? `Aku belum punya tagihan rutin bernama “${target.name}”. Mau dibuat? Contoh: “tagihan ${target.name} 350rb tiap tanggal 5”.`
        : "Tagihan ini sudah tidak aktif.",
    );
  return row;
}
// Records the payment as an expense and moves the bill to its next month.
export async function payBill(
  tx: Tx,
  ownerId: string,
  target: { id?: string; name?: string | null; amount?: string | null },
  messageId: string,
  now: Date,
  zone: string,
) {
  const bill = await findBill(tx, ownerId, target);
  const amount = target.amount ?? bill.amount?.toString() ?? null;
  if (!amount)
    return `Berapa tagihan ${bill.name} kali ini? Balas misalnya “bayar ${bill.name.toLowerCase()} 450rb”.`;
  // Paid already this cycle: the next due date is still far away.
  if (
    bill.lastPaidAt &&
    bill.nextDueAt.getTime() - now.getTime() > 10 * 86400000
  )
    return `Tagihan ${bill.name} untuk periode ini sudah tercatat lunas. Jatuh tempo berikutnya ${dayMonth(bill.nextDueAt, zone)}.`;
  const transaction = await saveTransaction(
    tx,
    ownerId,
    {
      type: "expense",
      amount,
      occurredAt: now.toISOString(),
      category: bill.category,
      description: `Tagihan ${bill.name}`,
      paymentMethod: bill.paymentMethod,
    },
    { source: "telegram", messageId, now, zone },
  );
  const nextDueAt = dueIn(
    DateTime.fromJSDate(bill.nextDueAt).setZone(zone).plus({ months: 1 }),
    bill.dueDay,
  ).toJSDate();
  const updated = await tx.bill.update({
    where: { id: bill.id },
    data: { lastPaidAt: now, nextDueAt },
  });
  await audit(tx, ownerId, "bill.pay", bill.id, bill, updated);
  return `✅ Tagihan ${bill.name} ${rupiah(amount)} sudah aku catat sebagai pengeluaran. Jatuh tempo berikutnya ${dayMonth(nextDueAt, zone)}.\nID transaksi: ${transaction.id}`;
}
export async function cancelBill(tx: Tx, ownerId: string, name: string | null) {
  const bill = await findBill(tx, ownerId, { name });
  const updated = await tx.bill.update({
    where: { id: bill.id },
    data: { status: "cancelled" },
  });
  await audit(tx, ownerId, "bill.cancel", bill.id, bill, updated);
  return `Oke, tagihan ${bill.name} sudah aku hapus dari daftar. Nggak akan aku ingatkan lagi.`;
}
export async function upcomingBills(tx: Tx, ownerId: string, until?: Date) {
  return tx.bill.findMany({
    where: {
      ownerId,
      status: "active",
      ...(until ? { nextDueAt: { lte: until } } : {}),
    },
    orderBy: { nextDueAt: "asc" },
  });
}
export async function listBills(
  tx: Tx,
  ownerId: string,
  now: Date,
  zone: string,
) {
  const rows = await upcomingBills(tx, ownerId);
  if (!rows.length)
    return "Belum ada tagihan rutin. Contoh: “tagihan internet 350rb tiap tanggal 5”.";
  const monthEnd = DateTime.fromJSDate(now).setZone(zone).endOf("month");
  const thisMonth = rows.filter(
    (b) => b.nextDueAt <= monthEnd.toJSDate() && b.amount,
  );
  const total = thisMonth.reduce((s, b) => s + (b.amount ?? 0n), 0n);
  return [
    `Tagihan rutinmu (${rows.length}):`,
    ...rows.map(
      (b) =>
        `${b.nextDueAt < now ? "⚠️" : "🔔"} ${b.name} — ${amountText(b.amount)}, jatuh tempo ${dayMonth(b.nextDueAt, zone)}${b.nextDueAt < now ? " (lewat, belum dibayar)" : ""}`,
    ),
    ...(total
      ? ["", `Yang masih harus dibayar bulan ini: ${rupiah(total)}`]
      : []),
  ].join("\n");
}
// Sends at most one reminder per stage and due date; job keys make this idempotent.
export async function billReminders(
  database: Database,
  now: Date,
  zone: string,
) {
  return database.$transaction(async (tx) => {
    const bills = await tx.bill.findMany({
      where: {
        status: "active",
        nextDueAt: { lte: new Date(now.getTime() + soonDays * 86400000) },
      },
      take: 100,
    });
    for (const b of bills) {
      const due = DateTime.fromJSDate(b.nextDueAt).setZone(zone);
      const local = DateTime.fromJSDate(now).setZone(zone);
      // Only at or after 09:00, so reminders never arrive at night.
      if (local.hour < reminderHour) continue;
      const days = Math.round(
        due.startOf("day").diff(local.startOf("day"), "days").days,
      );
      const stage =
        days <= -lateDays
          ? "late"
          : days <= 0
            ? "due"
            : days <= soonDays
              ? "soon"
              : null;
      if (!stage) continue;
      const text =
        stage === "soon"
          ? `🔔 Tagihan ${b.name} (${amountText(b.amount)}) jatuh tempo ${dayMonth(b.nextDueAt, zone)}, ${days} hari lagi.`
          : stage === "due"
            ? `📅 Hari ini jatuh tempo: tagihan ${b.name} (${amountText(b.amount)}).`
            : `⚠️ Tagihan ${b.name} sudah lewat ${-days} hari dari jatuh tempo (${dayMonth(b.nextDueAt, zone)}). Sudah dibayar?`;
      await enqueue(
        tx,
        b.ownerId,
        `bill:${b.id}:${due.toISODate()}:${stage}`,
        {
          text: `${text}\nKalau sudah, tekan tombol di bawah biar aku catat.`,
          buttons: [[{ text: "✅ Udah bayar", data: `paid:${b.id}` }]],
        },
        now,
      );
    }
    return { checked: bills.length };
  });
}
