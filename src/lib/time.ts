import { DateTime } from "luxon";
import { AppError } from "./errors";
export type Period = "today" | "week" | "month" | "previous_month" | "day";
export function dateRange(period: Period, now: Date, zone = "Asia/Jakarta") {
  let local = DateTime.fromJSDate(now).setZone(zone);
  if (period === "previous_month") local = local.minus({ months: 1 });
  const unit =
    period === "week"
      ? "week"
      : period === "month" || period === "previous_month"
        ? "month"
        : "day";
  const start = local.startOf(unit);
  return {
    start: start.toJSDate(),
    end: start
      .plus(
        unit === "month"
          ? { months: 1 }
          : unit === "week"
            ? { weeks: 1 }
            : { days: 1 },
      )
      .toJSDate(),
  };
}
export function localDate(value: string, zone = "Asia/Jakarta") {
  const result = DateTime.fromISO(value, { zone });
  if (!result.isValid)
    throw new AppError("INVALID_DATE", 422, "Tanggal tidak valid.");
  return result.toJSDate();
}
export function displayDate(date: Date, zone = "Asia/Jakarta") {
  return DateTime.fromJSDate(date)
    .setZone(zone)
    .setLocale("id")
    .toFormat("dd LLL yyyy HH:mm ZZZZ");
}
export function nextOccurrence(
  scheduled: Date,
  recurrence: string,
  anchorDay: number,
  now: Date,
  zone = "Asia/Jakarta",
): Date | null {
  if (recurrence === "once") return null;
  let next = DateTime.fromJSDate(scheduled).setZone(zone);
  const current = DateTime.fromJSDate(now).setZone(zone);
  if (recurrence === "monthly") {
    const months = Math.max(
      1,
      (current.year - next.year) * 12 + current.month - next.month,
    );
    next = next.set({ day: 1 }).plus({ months });
    next = next.set({ day: Math.min(anchorDay, next.daysInMonth!) });
    if (next.toMillis() <= current.toMillis()) {
      next = next.set({ day: 1 }).plus({ months: 1 });
      next = next.set({ day: Math.min(anchorDay, next.daysInMonth!) });
    }
  } else {
    const days = recurrence === "weekly" ? 7 : 1;
    const missed = Math.max(
      1,
      Math.floor(current.diff(next, "days").days / days),
    );
    next = next.plus({ days: missed * days });
    if (next.toMillis() <= current.toMillis()) next = next.plus({ days });
  }
  return next.toJSDate();
}
