import type { Tx } from "@/lib/db";
import { audit } from "@/lib/db";
import { taskInput, noteInput, reminderInput } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import { DateTime } from "luxon";

export function resolveMatch<T extends { id: string; title: string }>(
  matches: T[],
) {
  if (!matches.length)
    throw new AppError(
      "RECORD_NOT_FOUND",
      404,
      "Tidak ada catatan yang cocok.",
    );
  if (matches.length > 1)
    throw new AppError(
      "AMBIGUOUS_MATCH",
      409,
      `Ada beberapa yang cocok. Sebutkan ID: ${matches.map((m) => `${m.title} (${m.id})`).join("; ")}`,
    );
  return matches[0];
}
export async function saveTask(
  tx: Tx,
  ownerId: string,
  input: unknown,
  id?: string,
  now = new Date(),
) {
  const data = taskInput.parse(input);
  const before = id
    ? await tx.task.findFirst({ where: { id, ownerId } })
    : null;
  if (id && !before) throw new AppError("TASK_NOT_FOUND", 404);
  const values = {
    ...data,
    dueAt: data.dueAt ? new Date(data.dueAt) : null,
    completedAt:
      data.status === "completed" ? before?.completedAt || now : null,
  };
  const result = id
    ? await tx.task.update({ where: { id }, data: values })
    : await tx.task.create({ data: { ...values, ownerId } });
  await audit(
    tx,
    ownerId,
    id ? "task.update" : "task.create",
    result.id,
    before,
    result,
  );
  return result;
}
export async function saveNote(
  tx: Tx,
  ownerId: string,
  input: unknown,
  id?: string,
) {
  const data = noteInput.parse(input);
  const before = id
    ? await tx.note.findFirst({ where: { id, ownerId } })
    : null;
  if (id && !before) throw new AppError("NOTE_NOT_FOUND", 404);
  const result = id
    ? await tx.note.update({ where: { id }, data })
    : await tx.note.create({ data: { ...data, ownerId } });
  await audit(
    tx,
    ownerId,
    id ? "note.update" : "note.create",
    result.id,
    before,
    result,
  );
  return result;
}
export async function saveReminder(
  tx: Tx,
  ownerId: string,
  input: unknown,
  id?: string,
  now = new Date(),
) {
  const data = reminderInput.parse(input);
  const local = DateTime.fromISO(data.scheduledAt).setZone(data.timezone);
  if (!local.isValid) throw new AppError("INVALID_TIMEZONE", 422);
  if (data.status === "active" && local.toMillis() <= now.getTime())
    throw new AppError(
      "REMINDER_IN_PAST",
      422,
      "Pilih waktu pengingat di masa depan.",
    );
  const before = id
    ? await tx.reminder.findFirst({ where: { id, ownerId } })
    : null;
  if (id && !before) throw new AppError("REMINDER_NOT_FOUND", 404);
  if (
    data.taskId &&
    !(await tx.task.findFirst({ where: { id: data.taskId, ownerId } }))
  )
    throw new AppError("TASK_NOT_FOUND", 404);
  const values = {
    ...data,
    scheduledAt: local.toJSDate(),
    nextRunAt: data.status === "active" ? local.toJSDate() : null,
    anchorDay: local.day,
    deliveryStatus: "pending",
    lastError: null,
  };
  const result = id
    ? await tx.reminder.update({
        where: { id },
        data: { ...values, generation: { increment: 1 } },
      })
    : await tx.reminder.create({ data: { ...values, ownerId } });
  if (id)
    await tx.job.updateMany({
      where: {
        ownerId,
        status: { in: ["pending", "retry", "blocked"] },
        payload: { path: ["reminderId"], equals: id },
      },
      data: { status: "cancelled" },
    });
  await audit(
    tx,
    ownerId,
    id ? "reminder.update" : "reminder.create",
    result.id,
    before,
    result,
  );
  return result;
}
