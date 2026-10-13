import type { Database } from "@/lib/db";
import { nextOccurrence, displayDate } from "@/lib/time";
import { enqueue } from "./queue";

export async function materializeReminders(
  database: Database,
  now = new Date(),
) {
  return database.$transaction(async (tx) => {
    const due = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Reminder" WHERE status = 'active' AND "nextRunAt" <= ${now} ORDER BY "nextRunAt" LIMIT 100 FOR UPDATE SKIP LOCKED`;
    for (const { id } of due) {
      const reminder = await tx.reminder.findUniqueOrThrow({ where: { id } });
      const occurrence = reminder.nextRunAt!;
      await enqueue(
        tx,
        reminder.ownerId,
        `reminder:${id}:${reminder.generation}:${occurrence.toISOString()}`,
        {
          text: `Pengingat: ${reminder.title}${reminder.message ? ` — ${reminder.message}` : ""}. Jadwal: ${displayDate(occurrence, reminder.timezone)}.`,
          reminderId: id,
          generation: reminder.generation,
          occurrenceAt: occurrence.toISOString(),
        },
        now,
      );
      const nextRunAt = nextOccurrence(
        occurrence,
        reminder.recurrence,
        reminder.anchorDay,
        now,
        reminder.timezone,
      );
      await tx.reminder.update({
        where: { id },
        data: {
          nextRunAt,
          status: nextRunAt ? "active" : "scheduled",
          deliveryStatus: "queued",
          lastOccurrenceAt: occurrence,
        },
      });
    }
    return { queued: due.length };
  });
}
