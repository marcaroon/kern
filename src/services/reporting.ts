import type { Tx } from "@/lib/db";
import { dateRange, displayDate } from "@/lib/time";
import { financeSummary, budgetStatus, categoryLabel, rupiah } from "./finance";
import { financeInsights } from "./insights";
export async function dashboard(
  tx: Tx,
  ownerId: string,
  now = new Date(),
  zone = "Asia/Jakarta",
) {
  const today = dateRange("today", now, zone);
  const [
    month,
    previousMonth,
    day,
    budgets,
    tasks,
    overdue,
    reminders,
    transactions,
    notes,
    sync,
    jobs,
  ] = await Promise.all([
    financeSummary(tx, ownerId, "month", now, zone),
    financeSummary(tx, ownerId, "previous_month", now, zone),
    financeSummary(tx, ownerId, "today", now, zone),
    budgetStatus(tx, ownerId, now, zone),
    tx.task.findMany({
      where: {
        ownerId,
        status: { in: ["open", "in_progress"] },
        OR: [{ dueAt: { gte: today.start, lt: today.end } }, { dueAt: null }],
      },
      orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
      take: 15,
    }),
    tx.task.count({
      where: {
        ownerId,
        status: { in: ["open", "in_progress"] },
        dueAt: { lt: now },
      },
    }),
    tx.reminder.findMany({
      where: { ownerId, status: "active" },
      orderBy: { nextRunAt: "asc" },
      take: 8,
    }),
    tx.transaction.findMany({
      where: { ownerId },
      orderBy: { occurredAt: "desc" },
      take: 8,
    }),
    tx.note.findMany({
      where: { ownerId, archived: false },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    tx.sheetSyncOutbox.groupBy({
      by: ["status"],
      where: { ownerId },
      _count: true,
    }),
    tx.job.groupBy({ by: ["status"], where: { ownerId }, _count: true }),
  ]);
  return {
    month,
    previousMonth,
    day,
    budgets,
    tasks,
    overdue,
    reminders,
    transactions,
    notes,
    sync,
    jobs,
  };
}
export async function report(
  tx: Tx,
  ownerId: string,
  kind: "daily" | "weekly" | "recap",
  now = new Date(),
  zone = "Asia/Jakarta",
) {
  const range = dateRange(kind === "weekly" ? "week" : "today", now, zone);
  const [money, tasks, completed, notes, reminders, budgets, insights] =
    await Promise.all([
      financeSummary(
        tx,
        ownerId,
        kind === "weekly" ? "week" : "today",
        now,
        zone,
      ),
      tx.task.findMany({
        where: { ownerId, status: { in: ["open", "in_progress"] } },
        orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
        take: 15,
      }),
      tx.task.count({
        where: {
          ownerId,
          status: "completed",
          completedAt: { gte: range.start, lt: range.end },
        },
      }),
      tx.note.findMany({
        where: {
          ownerId,
          archived: false,
          createdAt: { gte: range.start, lt: range.end },
        },
        take: 5,
        orderBy: { createdAt: "desc" },
      }),
      tx.reminder.findMany({
        where: { ownerId, status: "active" },
        orderBy: { nextRunAt: "asc" },
        take: 5,
      }),
      budgetStatus(tx, ownerId, now, zone),
      financeInsights(tx, ownerId, now, zone),
    ]);
  // Mornings show only what needs attention; the weekly review shows everything.
  const shown = insights.filter(
    (i) => kind === "weekly" || i.level === "alert",
  );
  return [
    kind === "weekly"
      ? "Review mingguan KERN"
      : kind === "recap"
        ? "Rekap harian KERN"
        : "Agenda harian KERN",
    `Berdasarkan data yang dicatat (${displayDate(range.start, zone)}).`,
    `Pemasukan ${rupiah(money.income)}; pengeluaran ${rupiah(money.expense)} (${money.count} transaksi).`,
    ...Object.entries(money.categories).map(
      ([name, amount]) => `${categoryLabel(name)}: ${rupiah(amount)}`,
    ),
    ...(shown.length
      ? ["", "Insight keuangan:", ...shown.map((i) => i.text), ""]
      : []),
    `Task selesai: ${completed}. Prioritas terbuka (maks. 15):`,
    ...tasks.map(
      (t) =>
        `• P${t.priority} ${t.title}${t.dueAt ? ` — ${displayDate(t.dueAt, zone)}${t.dueAt < now ? " (terlewat)" : ""}` : " — tanpa tenggat"}`,
    ),
    ...(tasks.length ? [] : ["Tidak ada task terbuka."]),
    ...reminders.map(
      (r) => `Pengingat: ${r.title} — ${displayDate(r.nextRunAt!, zone)}`,
    ),
    ...budgets
      .filter((b) => b.warning)
      .filter(() => !insights.length)
      .map(
        (b) =>
          `Anggaran ${categoryLabel(b.category)}: ${b.percent}% digunakan.`,
      ),
    ...notes.map((n) => `Catatan: ${n.title}`),
    "Data ini hanya mencakup aktivitas yang disimpan di KERN.",
  ]
    .join("\n")
    .slice(0, 3900);
}
