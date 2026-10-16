import { z } from "zod";
import { DateTime } from "luxon";
import type { Tx } from "@/lib/db";
import { audit } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { isoDate, money } from "@/lib/validation";
import { byName } from "@/lib/match";
import { rupiah } from "./finance";

export const goalInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    target: money,
    deadline: isoDate.nullable(),
  })
  .strict();
type Goal = {
  id: string;
  name: string;
  target: bigint;
  saved: bigint;
  deadline: Date | null;
  status: string;
  createdAt: Date;
};

// Ten-block progress bar from exact integers.
export function progressBar(saved: bigint, target: bigint) {
  const filled = Number(saved >= target ? 10n : (saved * 10n) / target);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}
const percent = (saved: bigint, target: bigint) =>
  (saved >= target ? 100n : (saved * 100n) / target).toString();
// Rupiah per week still needed to reach the target by the deadline (rounded up).
export function weeklyNeed(goal: Goal, now: Date) {
  if (!goal.deadline || goal.saved >= goal.target) return null;
  const weeks = Math.ceil(
    (goal.deadline.getTime() - now.getTime()) / (7 * 86400000),
  );
  if (weeks <= 0) return null;
  const left = goal.target - goal.saved;
  return (left + BigInt(weeks) - 1n) / BigInt(weeks);
}
// Behind when savings trail the straight line from start to deadline by over 20%.
export function behindSchedule(goal: Goal, now: Date) {
  if (!goal.deadline || goal.saved >= goal.target) return false;
  const total = goal.deadline.getTime() - goal.createdAt.getTime();
  const elapsed = Math.min(now.getTime() - goal.createdAt.getTime(), total);
  if (total <= 0 || elapsed < 7 * 86400000) return false;
  const expected =
    (goal.target * BigInt(Math.round((elapsed / total) * 1000))) / 1000n;
  return goal.saved * 10n < expected * 8n;
}
export function goalLine(goal: Goal, now: Date, zone: string) {
  const deadline = goal.deadline
    ? DateTime.fromJSDate(goal.deadline)
        .setZone(zone)
        .setLocale("id")
        .toFormat("d LLL yyyy")
    : null;
  const need = weeklyNeed(goal, now);
  return [
    `🎯 ${goal.name}: ${rupiah(goal.saved)} / ${rupiah(goal.target)} (${percent(goal.saved, goal.target)}%)`,
    `   ${progressBar(goal.saved, goal.target)}${
      goal.saved >= goal.target
        ? " tercapai 🎉"
        : need
          ? ` · perlu ${rupiah(need)}/minggu sampai ${deadline}`
          : deadline && goal.deadline! <= now
            ? ` · tenggat ${deadline} sudah lewat`
            : ""
    }`,
  ].join("\n");
}
async function findGoal(tx: Tx, ownerId: string, name: string | null) {
  const active = await tx.goal.findMany({
    where: { ownerId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (!active.length)
    throw new AppError(
      "GOAL_NOT_FOUND",
      404,
      "Kamu belum punya target tabungan. Contoh: “nabung 5jt buat laptop sampai Maret”.",
    );
  if (!name) {
    if (active.length === 1) return active[0];
    throw new AppError(
      "GOAL_AMBIGUOUS",
      422,
      `Buat target yang mana? ${active.map((g) => g.name).join(", ")}.`,
    );
  }
  const goal = byName(active, name);
  if (!goal)
    throw new AppError(
      "GOAL_NOT_FOUND",
      404,
      `Aku nggak menemukan target “${name}”. Targetmu: ${active.map((g) => g.name).join(", ")}.`,
    );
  return goal;
}
export async function saveGoal(
  tx: Tx,
  ownerId: string,
  input: unknown,
  now: Date,
  zone: string,
) {
  const parsed = goalInput.parse(input);
  const deadline = parsed.deadline
    ? DateTime.fromISO(parsed.deadline).setZone(zone).endOf("day").toJSDate()
    : null;
  if (deadline && deadline <= now)
    throw new AppError(
      "GOAL_DEADLINE_PAST",
      422,
      "Tenggatnya sudah lewat. Pilih tanggal di masa depan, ya.",
    );
  const row = await tx.goal.create({
    data: {
      ownerId,
      name: parsed.name,
      target: BigInt(parsed.target),
      deadline,
      createdAt: now,
    },
  });
  await audit(tx, ownerId, "goal.create", row.id, null, row);
  const need = weeklyNeed(row, now);
  return `🎯 Target “${row.name}” ${rupiah(row.target)} dibuat${need ? `. Biar tercapai, sisihkan sekitar ${rupiah(need)} per minggu` : ""}. Bilang aja “nabung 200rb buat ${row.name.toLowerCase()}” tiap kali kamu menyisihkan uang.`;
}
// Positive amounts add savings, negative ones take them out (never below zero).
export async function changeSaving(
  tx: Tx,
  ownerId: string,
  name: string | null,
  amount: string,
  sign: 1n | -1n,
  now: Date,
  zone: string,
) {
  const goal = await findGoal(tx, ownerId, name);
  const delta = BigInt(money.parse(amount)) * sign;
  if (goal.saved + delta < 0n)
    throw new AppError(
      "GOAL_NEGATIVE",
      422,
      `Tabungan ${goal.name} cuma ${rupiah(goal.saved)}, nggak bisa diambil ${rupiah(-delta)}.`,
    );
  const saved = goal.saved + delta;
  const achieved = saved >= goal.target;
  const updated = await tx.goal.update({
    where: { id: goal.id },
    data: {
      saved,
      ...(achieved && !goal.achievedAt ? { achievedAt: now } : {}),
    },
  });
  await audit(
    tx,
    ownerId,
    sign > 0n ? "goal.deposit" : "goal.withdraw",
    goal.id,
    goal,
    updated,
  );
  const head =
    sign > 0n
      ? achieved && !goal.achievedAt
        ? `🎉 Selamat! Target ${goal.name} tercapai!`
        : `💪 Mantap, ${rupiah(delta)} masuk ke tabungan ${goal.name}.`
      : `Oke, ${rupiah(-delta)} diambil dari tabungan ${goal.name}.`;
  return `${head}\n${goalLine(updated, now, zone)}`;
}
export async function listGoals(
  tx: Tx,
  ownerId: string,
  now: Date,
  zone: string,
) {
  const rows = await tx.goal.findMany({
    where: { ownerId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (!rows.length)
    return "Belum ada target tabungan. Contoh: “nabung 5jt buat laptop sampai Maret”.";
  return [
    "Target tabunganmu:",
    ...rows.map((g) => goalLine(g, now, zone)),
  ].join("\n");
}
export async function cancelGoal(tx: Tx, ownerId: string, name: string | null) {
  const goal = await findGoal(tx, ownerId, name);
  const updated = await tx.goal.update({
    where: { id: goal.id },
    data: { status: "cancelled" },
  });
  await audit(tx, ownerId, "goal.cancel", goal.id, goal, updated);
  return `Oke, target ${goal.name} aku hapus dari daftar. Uang yang sudah kamu sisihkan (${rupiah(goal.saved)}) tetap milikmu, cuma nggak dipantau lagi.`;
}
