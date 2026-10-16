import { DateTime } from "luxon";
import type { Tx } from "@/lib/db";
import { budgetStatus, categoryLabel, rupiah } from "./finance";
import { upcomingBills } from "./bills";
import { debtSummary } from "./debts";
import { behindSchedule, goalLine, weeklyNeed } from "./goals";

// One decimal place without floating point: 18 -> "1,8".
const ratio = (part: bigint, whole: bigint) => {
  const tenths = (part * 10n) / whole;
  return `${tenths / 10n},${tenths % 10n}`;
};
type Insight = { level: "alert" | "info"; text: string };

// Deterministic observations from recorded data only; nothing is estimated by AI.
export async function financeInsights(
  tx: Tx,
  ownerId: string,
  now: Date,
  zone: string,
): Promise<Insight[]> {
  const local = DateTime.fromJSDate(now).setZone(zone);
  const today = local.startOf("day");
  const weekStart = today.minus({ days: 6 });
  const baseStart = weekStart.minus({ days: 28 });
  const [budgets, recent, bills, debts, goals] = await Promise.all([
    budgetStatus(tx, ownerId, now, zone),
    tx.transaction.findMany({
      where: {
        ownerId,
        status: "active",
        type: "expense",
        occurredAt: { gte: baseStart.toJSDate(), lt: now },
      },
      select: { amount: true, category: true, occurredAt: true },
    }),
    upcomingBills(tx, ownerId, today.plus({ days: 8 }).toJSDate()),
    tx.debt.findMany({
      where: { ownerId, status: "open" },
      orderBy: { createdAt: "asc" },
    }),
    tx.goal.findMany({
      where: { ownerId, status: "active" },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const insights: Insight[] = [];

  // Budget pace: compare the share spent with the share of the month elapsed.
  const daysInMonth = local.daysInMonth!;
  const daysLeft = BigInt(daysInMonth - local.day + 1);
  const elapsed = (local.day * 100) / daysInMonth;
  for (const b of budgets) {
    const left = b.amount - b.spent;
    const name = categoryLabel(b.category);
    if (left <= 0n)
      insights.push({
        level: "alert",
        text: `🔴 Anggaran ${name} sudah habis: terpakai ${rupiah(b.spent)} dari ${rupiah(b.amount)}${left < 0n ? `, lewat ${rupiah(-left)}` : ""}.`,
      });
    else if (Number(b.percent) > elapsed + 15)
      insights.push({
        level: "alert",
        text: `🟡 Anggaran ${name} sudah terpakai ${b.percent}%, padahal bulan baru jalan ${Math.round(elapsed)}%. Sisa ${rupiah(left)}, sekitar ${rupiah(left / daysLeft)} per hari.`,
      });
    else
      insights.push({
        level: "info",
        text: `🟢 Anggaran ${name} aman: sisa ${rupiah(left)}, sekitar ${rupiah(left / daysLeft)} per hari.`,
      });
  }

  // Spending spikes: the last 7 days against the weekly average of the 4 weeks before.
  const week: Record<string, bigint> = {};
  const base: Record<string, bigint> = {};
  for (const t of recent) {
    const bucket = t.occurredAt >= weekStart.toJSDate() ? week : base;
    bucket[t.category] = (bucket[t.category] || 0n) + t.amount;
  }
  const spikes = Object.entries(week)
    .map(([category, amount]) => ({
      category,
      amount,
      average: (base[category] || 0n) / 4n,
    }))
    .filter(
      (s) =>
        s.average > 0n &&
        s.amount * 2n >= s.average * 3n &&
        s.amount - s.average >= 50000n,
    )
    .sort((a, b) => (b.amount - b.average > a.amount - a.average ? 1 : -1))
    .slice(0, 2);
  for (const s of spikes)
    insights.push({
      level: "alert",
      text: `📈 Pengeluaran ${categoryLabel(s.category)} 7 hari terakhir ${rupiah(s.amount)}, ${ratio(s.amount, s.average)}× rata-rata mingguanmu (${rupiah(s.average)}).`,
    });

  // Bills due within a week.
  if (bills.length) {
    const fixed = bills.reduce((sum, b) => sum + (b.amount ?? 0n), 0n);
    const soon = bills.some(
      (b) => b.nextDueAt <= today.plus({ days: 4 }).toJSDate(),
    );
    insights.push({
      level: soon ? "alert" : "info",
      text: `🔔 Tagihan 7 hari ke depan: ${bills
        .map(
          (b) =>
            `${b.name} (${DateTime.fromJSDate(b.nextDueAt).setZone(zone).setLocale("id").toFormat("d LLL")}${b.amount ? `, ${rupiah(b.amount)}` : ""})`,
        )
        .join(", ")}${fixed ? `. Siapkan sekitar ${rupiah(fixed)}` : ""}.`,
    });
  }

  // Open debts.
  const { owedToMe, iOwe } = debtSummary(debts);
  const oldest = debts.find((d) => d.direction === "owed_to_me");
  if (owedToMe > 0n && oldest) {
    const days = Math.floor(
      (now.getTime() - oldest.createdAt.getTime()) / 86400000,
    );
    insights.push({
      level: days >= 7 ? "alert" : "info",
      text: `💰 Piutang belum kembali ${rupiah(owedToMe)} dari ${new Set(debts.filter((d) => d.direction === "owed_to_me").map((d) => d.person.toLowerCase())).size} orang${days >= 1 ? ` (paling lama: ${oldest.person}, ${days} hari)` : ""}.`,
    });
  }
  if (iOwe > 0n)
    insights.push({
      level: "info",
      text: `💸 Utangmu yang belum dibayar: ${rupiah(iOwe)}.`,
    });

  // Savings goals: behind the straight line to the deadline, or just progress.
  for (const g of goals) {
    const need = weeklyNeed(g, now);
    insights.push(
      behindSchedule(g, now)
        ? {
            level: "alert",
            text: `🎯 Target ${g.name} agak ketinggalan: baru ${rupiah(g.saved)} dari ${rupiah(g.target)}.${need ? ` Perlu sekitar ${rupiah(need)} per minggu biar tetap tercapai.` : ""}`,
          }
        : { level: "info", text: goalLine(g, now, zone) },
    );
  }
  return insights;
}
export async function insightText(
  tx: Tx,
  ownerId: string,
  now: Date,
  zone: string,
) {
  const insights = await financeInsights(tx, ownerId, now, zone);
  if (!insights.length)
    return "Belum ada cukup data buat dianalisis. Coba catat pengeluaran beberapa hari dan pasang anggaran, misalnya “anggaran makan 2jt bulan ini”.";
  const alerts = insights.filter((i) => i.level === "alert");
  return [
    alerts.length
      ? "Ini yang perlu kamu perhatikan:"
      : "Keuanganmu sejauh ini aman 👍",
    ...alerts.map((i) => i.text),
    ...(alerts.length && insights.length > alerts.length ? [""] : []),
    ...insights.filter((i) => i.level === "info").map((i) => i.text),
    "",
    "Dihitung dari transaksi yang kamu catat di KERN.",
  ].join("\n");
}
