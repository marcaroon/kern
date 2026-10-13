import type { Tx } from "@/lib/db";
import { audit } from "@/lib/db";
import { transactionInput, budgetInput } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import { dateRange, type Period } from "@/lib/time";
import { DateTime } from "luxon";
import { enqueue } from "./queue";

export function rupiah(amount: bigint | string) {
  return `Rp${BigInt(amount).toLocaleString("id-ID")}`;
}
export function totals(
  rows: { type: string; amount: bigint; status?: string; category: string }[],
) {
  let income = 0n,
    expense = 0n;
  const categories: Record<string, bigint> = {};
  for (const row of rows) {
    if (row.status === "void") continue;
    if (row.type === "income") income += row.amount;
    if (row.type === "expense") {
      expense += row.amount;
      categories[row.category] = (categories[row.category] || 0n) + row.amount;
    }
  }
  return { income, expense, balance: income - expense, categories };
}
export function budgetUsage(
  spent: bigint,
  amount: bigint,
  warningPercent: number,
) {
  return {
    spent,
    amount,
    percent: amount > 0n ? ((spent * 100n) / amount).toString() : "0",
    warning: spent * 100n >= amount * BigInt(warningPercent),
    exceeded: spent >= amount,
  };
}
export async function financeSummary(
  tx: Tx,
  ownerId: string,
  period: Period,
  now = new Date(),
  zone = "Asia/Jakarta",
) {
  const { start, end } = dateRange(period, now, zone);
  const rows = await tx.transaction.findMany({
    where: { ownerId, status: "active", occurredAt: { gte: start, lt: end } },
    select: { type: true, amount: true, category: true },
  });
  return {
    ...totals(rows),
    count: rows.length,
    start,
    end,
    recordedOnly: true,
  };
}
export async function budgetStatus(
  tx: Tx,
  ownerId: string,
  now = new Date(),
  zone = "Asia/Jakarta",
) {
  const month = DateTime.fromJSDate(now).setZone(zone).toFormat("yyyy-MM");
  const [budgets, summary] = await Promise.all([
    tx.budget.findMany({ where: { ownerId, month } }),
    financeSummary(tx, ownerId, "month", now, zone),
  ]);
  return budgets.map((b) => ({
    ...b,
    ...budgetUsage(
      summary.categories[b.category] || 0n,
      b.amount,
      b.warningPercent,
    ),
  }));
}
async function budgetAlerts(tx: Tx, ownerId: string, now: Date, zone: string) {
  for (const b of await budgetStatus(tx, ownerId, now, zone)) {
    for (const threshold of [...new Set([b.warningPercent, 100])]) {
      if (b.spent * 100n < b.amount * BigInt(threshold)) continue;
      const result = await tx.budgetAlert.createMany({
        data: { ownerId, month: b.month, category: b.category, threshold },
        skipDuplicates: true,
      });
      if (result.count)
        await enqueue(
          tx,
          ownerId,
          `budget:${b.id}:${threshold}`,
          {
            text: `Anggaran ${b.category} ${b.month} mencapai ${threshold}%. Tercatat ${rupiah(b.spent)} dari ${rupiah(b.amount)}.`,
          },
          now,
        );
    }
  }
}
async function financeLock(tx: Tx, ownerId: string) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`finance:${ownerId}`}))`;
}
export async function saveTransaction(
  tx: Tx,
  ownerId: string,
  input: unknown,
  options: {
    id?: string;
    source?: string;
    messageId?: string;
    zone?: string;
    now?: Date;
  } = {},
) {
  const parsed = transactionInput.parse(input);
  await financeLock(tx, ownerId);
  for (const id of [parsed.accountId, parsed.toAccountId].filter(Boolean)) {
    if (!(await tx.account.findFirst({ where: { id: id!, ownerId } })))
      throw new AppError("ACCOUNT_NOT_FOUND", 404);
  }
  const before = options.id
    ? await tx.transaction.findFirst({
        where: { id: options.id, ownerId, status: "active" },
      })
    : null;
  if (options.id && !before) throw new AppError("TRANSACTION_NOT_FOUND", 404);
  const data = {
    ...parsed,
    amount: BigInt(parsed.amount),
    occurredAt: new Date(parsed.occurredAt),
    toAccountId: parsed.type === "transfer" ? parsed.toAccountId : null,
  };
  const result = before
    ? await tx.transaction.update({
        where: { id: before.id },
        data: { ...data, revision: { increment: 1 } },
      })
    : await tx.transaction.create({
        data: {
          ...data,
          ownerId,
          source: options.source || "dashboard",
          messageId: options.messageId,
        },
      });
  await tx.sheetSyncOutbox.create({
    data: {
      ownerId,
      transactionId: result.id,
      revision: result.revision,
      availableAt: options.now || new Date(),
    },
  });
  await audit(
    tx,
    ownerId,
    before ? "transaction.correct" : "transaction.create",
    result.id,
    before,
    result,
  );
  await budgetAlerts(
    tx,
    ownerId,
    options.now || new Date(),
    options.zone || "Asia/Jakarta",
  );
  return result;
}
export async function voidTransaction(
  tx: Tx,
  ownerId: string,
  id: string,
  now = new Date(),
) {
  await financeLock(tx, ownerId);
  const before = await tx.transaction.findFirst({
    where: { id, ownerId, status: "active" },
  });
  if (!before) throw new AppError("TRANSACTION_NOT_FOUND", 404);
  const result = await tx.transaction.update({
    where: { id },
    data: { status: "void", revision: { increment: 1 } },
  });
  await tx.sheetSyncOutbox.create({
    data: {
      ownerId,
      transactionId: id,
      revision: result.revision,
      availableAt: now,
    },
  });
  await audit(tx, ownerId, "transaction.void", id, before, result);
  return result;
}
export async function saveBudget(
  tx: Tx,
  ownerId: string,
  input: unknown,
  now = new Date(),
  zone = "Asia/Jakarta",
) {
  const parsed = budgetInput.parse(input);
  await financeLock(tx, ownerId);
  const where = {
    ownerId_month_category: {
      ownerId,
      month: parsed.month,
      category: parsed.category,
    },
  };
  const before = await tx.budget.findUnique({ where });
  const data = { ...parsed, amount: BigInt(parsed.amount) };
  const result = await tx.budget.upsert({
    where,
    create: { ...data, ownerId },
    update: data,
  });
  await audit(tx, ownerId, "budget.set", result.id, before, result);
  await budgetAlerts(tx, ownerId, now, zone);
  return result;
}
