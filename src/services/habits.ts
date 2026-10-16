import { z } from "zod";
import { DateTime } from "luxon";
import type { Database, Tx } from "@/lib/db";
import { audit } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { byName } from "@/lib/match";
import { enqueue } from "./queue";

export const habitInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    checkinTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("20:00"),
  })
  .strict();
const localDay = (date: Date, zone: string) =>
  DateTime.fromJSDate(date).setZone(zone).toISODate()!;

// Consecutive done days ending today, or yesterday when today is not logged yet.
export function streak(doneDays: Set<string>, now: Date, zone: string) {
  let day = DateTime.fromJSDate(now).setZone(zone).startOf("day");
  if (!doneDays.has(day.toISODate()!)) day = day.minus({ days: 1 });
  let count = 0;
  while (doneDays.has(day.toISODate()!)) {
    count++;
    day = day.minus({ days: 1 });
  }
  return count;
}
async function habitStats(tx: Tx, habitId: string, now: Date, zone: string) {
  const since = DateTime.fromJSDate(now)
    .setZone(zone)
    .minus({ days: 120 })
    .toISODate()!;
  const logs = await tx.habitLog.findMany({
    where: { habitId, day: { gte: since } },
    select: { day: true, done: true },
  });
  const done = new Set(logs.filter((l) => l.done).map((l) => l.day));
  const weekStart = DateTime.fromJSDate(now)
    .setZone(zone)
    .minus({ days: 6 })
    .toISODate()!;
  const today = logs.find((l) => l.day === localDay(now, zone))?.done ?? null;
  return {
    // An explicit skip today breaks the streak.
    streak: today === false ? 0 : streak(done, now, zone),
    week: [...done].filter((d) => d >= weekStart).length,
    today,
  };
}
async function findHabit(
  tx: Tx,
  ownerId: string,
  target: { id?: string; name?: string | null },
) {
  const active = await tx.habit.findMany({
    where: {
      ownerId,
      status: "active",
      ...(target.id ? { id: target.id } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  const habit = target.id
    ? active[0]
    : target.name
      ? byName(active, target.name)
      : active.length === 1
        ? active[0]
        : undefined;
  if (!habit)
    throw new AppError(
      "HABIT_NOT_FOUND",
      404,
      active.length
        ? `Kebiasaan yang mana? ${active.map((h) => h.name).join(", ")}.`
        : "Kamu belum memantau kebiasaan apa pun. Contoh: “pantau olahraga tiap hari jam 7 malam”.",
    );
  return habit;
}
export async function saveHabit(
  tx: Tx,
  ownerId: string,
  input: { name: string; at: string | null },
  zone: string,
) {
  const checkinTime = input.at
    ? DateTime.fromISO(input.at).setZone(zone).toFormat("HH:mm")
    : undefined;
  const parsed = habitInput.parse({ name: input.name, checkinTime });
  const existing = await tx.habit.findFirst({
    where: {
      ownerId,
      status: "active",
      name: { equals: parsed.name, mode: "insensitive" },
    },
  });
  const row = existing
    ? await tx.habit.update({
        where: { id: existing.id },
        data: { checkinTime: parsed.checkinTime },
      })
    : await tx.habit.create({ data: { ...parsed, ownerId } });
  await audit(
    tx,
    ownerId,
    existing ? "habit.update" : "habit.create",
    row.id,
    existing,
    row,
  );
  return `✅ Siap, aku pantau “${row.name}”. Tiap hari jam ${row.checkinTime} aku tanya sudah atau belum, cukup tekan tombolnya. Bisa juga lapor sendiri: “udah ${row.name.toLowerCase()} hari ini”.`;
}
// Logs today (idempotent per day; the latest answer wins) and reports the streak.
export async function logHabit(
  tx: Tx,
  ownerId: string,
  target: { id?: string; name?: string | null },
  done: boolean,
  now: Date,
  zone: string,
) {
  const habit = await findHabit(tx, ownerId, target);
  const day = localDay(now, zone);
  await tx.habitLog.upsert({
    where: { habitId_day: { habitId: habit.id, day } },
    create: { ownerId, habitId: habit.id, day, done },
    update: { done },
  });
  await audit(tx, ownerId, done ? "habit.done" : "habit.skip", habit.id, null, {
    day,
  });
  const stats = await habitStats(tx, habit.id, now, zone);
  if (!done)
    return `Oke, hari ini ${habit.name} dilewati. Nggak apa-apa, besok lanjut lagi ya 💪`;
  return stats.streak >= 2
    ? `🔥 Mantap! ${habit.name} hari ini tercatat. Streak ${stats.streak} hari berturut-turut.`
    : `✅ ${habit.name} hari ini tercatat. Ayo pertahankan besok!`;
}
export async function listHabits(
  tx: Tx,
  ownerId: string,
  now: Date,
  zone: string,
) {
  const habits = await tx.habit.findMany({
    where: { ownerId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (!habits.length)
    return "Belum ada kebiasaan yang dipantau. Contoh: “pantau olahraga tiap hari jam 7 malam”.";
  const lines = [];
  for (const h of habits) {
    const s = await habitStats(tx, h.id, now, zone);
    lines.push(
      `${s.today === true ? "✅" : s.today === false ? "⏭️" : "⬜"} ${h.name} — 7 hari terakhir ${s.week}/7${s.streak >= 2 ? `, streak ${s.streak} 🔥` : ""} (cek jam ${h.checkinTime})`,
    );
  }
  return ["Kebiasaanmu:", ...lines].join("\n");
}
export async function habitWeekSummary(
  tx: Tx,
  ownerId: string,
  now: Date,
  zone: string,
) {
  const habits = await tx.habit.findMany({
    where: { ownerId, status: "active" },
  });
  const lines = [];
  for (const h of habits) {
    const s = await habitStats(tx, h.id, now, zone);
    lines.push(
      `• ${h.name}: ${s.week}/7 hari${s.streak >= 2 ? `, streak ${s.streak}` : ""}`,
    );
  }
  return lines;
}
export async function cancelHabit(
  tx: Tx,
  ownerId: string,
  name: string | null,
) {
  const habit = await findHabit(tx, ownerId, { name });
  const updated = await tx.habit.update({
    where: { id: habit.id },
    data: { status: "archived" },
  });
  await audit(tx, ownerId, "habit.archive", habit.id, habit, updated);
  return `Oke, ${habit.name} nggak aku pantau lagi. Riwayatnya tetap tersimpan.`;
}
// After the check-in time, once per habit and day, unless already answered.
export async function habitCheckins(
  database: Database,
  now: Date,
  zone: string,
) {
  return database.$transaction(async (tx) => {
    const local = DateTime.fromJSDate(now).setZone(zone);
    const day = local.toISODate()!;
    const time = local.toFormat("HH:mm");
    const due = await tx.habit.findMany({
      where: {
        status: "active",
        checkinTime: { lte: time },
        logs: { none: { day } },
      },
      take: 50,
    });
    for (const h of due)
      await enqueue(
        tx,
        h.ownerId,
        `habit:${h.id}:${day}`,
        {
          text: `👋 Cek harian: sudah ${h.name.toLowerCase()} hari ini?`,
          buttons: [
            [
              { text: "✅ Sudah", data: `done:${h.id}` },
              { text: "❌ Belum", data: `skip:${h.id}` },
            ],
          ],
        },
        now,
      );
    return { checked: due.length };
  });
}
