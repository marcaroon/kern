import { z } from "zod";
import type { Tx } from "@/lib/db";
import { json } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { intentSchema, type Intent } from "./ai";
import {
  financeSummary,
  saveTransaction,
  voidTransaction,
  saveBudget,
  budgetStatus,
  rupiah,
} from "./finance";
import { saveTask, saveNote, saveReminder, resolveMatch } from "./records";
import { report } from "./reporting";
import { displayDate } from "@/lib/time";
import { DateTime } from "luxon";
import { money, isoDate } from "@/lib/validation";

const destructive = new Set([
  "correct_transaction",
  "void_transaction",
  "update_task",
  "cancel_task",
  "reschedule_reminder",
  "cancel_reminder",
  "update_note",
  "archive_note",
  "set_budget",
]);
const help =
  "KERN bisa mencatat pengeluaran/pemasukan, task, pengingat, ide, anggaran, dan laporan. Contoh:\n• Pengeluaran 35000 makan siang QRIS\n• Tambah task revisi dashboard\n• Ingatkan besok jam 9 pagi buat follow up vendor\n• Catat ide: SaaS klinik hewan\n• Total pengeluaran minggu ini\n• Cari catatan ESP32\nKoreksi/batalkan dengan ID dari balasan. Perubahan penting meminta “konfirmasi ID”.";

async function resolveTarget(tx: Tx, ownerId: string, input: Intent) {
  const e = input.entities;
  if (e.id) z.string().uuid().parse(e.id);
  const match = e.id
    ? { id: e.id }
    : {
        title: {
          contains: e.query || e.title || "",
          mode: "insensitive" as const,
        },
      };
  if (!e.id && !e.query && !e.title)
    throw new AppError(
      "MISSING_TARGET",
      422,
      "Sebutkan nama atau ID catatannya.",
    );
  if (input.intent.includes("transaction")) {
    if (!e.id)
      throw new AppError(
        "MISSING_ID",
        422,
        "Sebutkan ID transaksi dari konfirmasi atau dashboard.",
      );
    const row = await tx.transaction.findFirst({
      where: { ownerId, id: e.id, status: "active" },
    });
    if (!row)
      throw new AppError(
        "TRANSACTION_NOT_FOUND",
        404,
        "Transaksi tidak ditemukan.",
      );
    return { id: row.id, title: row.description, updatedAt: row.updatedAt };
  }
  const rows = input.intent.includes("task")
    ? await tx.task.findMany({
        where: { ownerId, ...match, status: { in: ["open", "in_progress"] } },
        take: 6,
      })
    : input.intent.includes("reminder")
      ? await tx.reminder.findMany({
          where: { ownerId, ...match, status: { not: "cancelled" } },
          take: 6,
        })
      : await tx.note.findMany({
          where: { ownerId, ...match, archived: false },
          take: 6,
        });
  return resolveMatch<{ id: string; title: string; updatedAt: Date }>(rows);
}
export async function executeIntent(
  tx: Tx,
  ownerId: string,
  raw: Intent,
  messageId: string,
  now: Date,
  zone: string,
  confirmed = false,
): Promise<string> {
  const input = intentSchema.parse(raw),
    e = input.entities;
  if (e.amount) money.parse(e.amount);
  if (e.date) isoDate.parse(e.date);
  if (
    input.confidence < 0.8 ||
    input.missing_fields.length ||
    input.intent === "clarify"
  )
    return (
      e.answer ||
      `Perjelas ${input.missing_fields.join(", ") || "pesannya"} sebelum disimpan.`
    );
  if (
    (destructive.has(input.intent) || input.requires_confirmation) &&
    !confirmed
  ) {
    const target =
      input.intent === "set_budget" || input.intent.startsWith("create_")
        ? null
        : await resolveTarget(tx, ownerId, input);
    if (target) e.id = target.id;
    const pending = await tx.pendingAction.create({
      data: {
        ownerId,
        payload: json({
          intent: input,
          targetUpdatedAt: target?.updatedAt?.toISOString() || null,
        }),
        expiresAt: new Date(now.getTime() + 10 * 60000),
      },
    });
    const changes = Object.entries(e)
      .filter(
        ([key, value]) =>
          value !== null && !["id", "query", "answer"].includes(key),
      )
      .map(
        ([key, value]) =>
          `${key}: ${key === "amount" ? rupiah(String(value)) : key === "date" ? displayDate(new Date(String(value)), zone) : Array.isArray(value) ? value.join(", ") : String(value)}`,
      )
      .join("\n");
    return `Tinjau perubahan: ${input.intent}${target ? ` — ${target.title} (${target.id})` : ""}.\n${changes.slice(0, 2500)}\nBalas “konfirmasi ${pending.id}” dalam 10 menit, atau abaikan untuk batal.`;
  }
  switch (input.intent) {
    case "help":
      return help;
    case "general":
      return `Informasi umum (bukan dari catatan pribadi): ${e.answer || "Silakan gunakan Bantuan untuk melihat kemampuan KERN."}`;
    case "create_transaction": {
      if (e.currency !== "IDR")
        return "KERN hanya mencatat rupiah (IDR). Sebutkan mata uang dan nominal yang jelas.";
      const row = await saveTransaction(
        tx,
        ownerId,
        {
          type: e.type,
          amount: e.amount,
          occurredAt: e.date || now.toISOString(),
          category: e.category || "other",
          description: e.title,
          paymentMethod: e.paymentMethod,
          accountId: e.accountId,
          toAccountId: e.toAccountId,
        },
        { source: "telegram", messageId, now, zone },
      );
      return `${row.type === "expense" ? "Pengeluaran" : row.type === "income" ? "Pemasukan" : "Transfer"} ${rupiah(row.amount)} dicatat sebagai ${row.category === "food" ? "Makan & Minum" : row.category}.${row.paymentMethod ? ` Pembayaran: ${row.paymentMethod}.` : ""}\nID: ${row.id}. Koreksi/batalkan dengan ID ini. Sinkronisasi Sheets masuk antrean.`;
    }
    case "correct_transaction":
    case "void_transaction": {
      const target = await resolveTarget(tx, ownerId, input);
      if (input.intent === "void_transaction") {
        await voidTransaction(tx, ownerId, target.id, now);
        return `Transaksi ${target.id} dibatalkan.`;
      }
      const row = await tx.transaction.findUniqueOrThrow({
        where: { id: target.id },
      });
      await saveTransaction(
        tx,
        ownerId,
        {
          type: e.type || row.type,
          amount: e.amount || row.amount.toString(),
          occurredAt: e.date || row.occurredAt.toISOString(),
          category: e.category || row.category,
          description: e.title || row.description,
          paymentMethod: e.paymentMethod || row.paymentMethod,
          accountId: e.accountId || row.accountId,
          toAccountId: e.toAccountId || row.toAccountId,
        },
        { id: row.id, now, zone },
      );
      return `Transaksi ${row.id} dikoreksi; riwayat disimpan.`;
    }
    case "create_task": {
      const row = await saveTask(
        tx,
        ownerId,
        {
          title: e.title,
          description: e.content,
          dueAt: e.date,
          priority: e.priority || 2,
          project: e.project,
        },
        undefined,
        now,
      );
      return `Task “${row.title}” disimpan${row.dueAt ? ` untuk ${displayDate(row.dueAt, zone)}` : ""}. ID: ${row.id}.`;
    }
    case "update_task":
    case "complete_task":
    case "cancel_task": {
      const target = await resolveTarget(tx, ownerId, input);
      const row = await tx.task.findUniqueOrThrow({ where: { id: target.id } });
      const result = await saveTask(
        tx,
        ownerId,
        {
          title:
            input.intent === "update_task" ? e.title || row.title : row.title,
          description: e.content || row.description,
          dueAt: e.date || row.dueAt?.toISOString() || null,
          project: e.project || row.project,
          priority: e.priority || row.priority,
          status:
            input.intent === "complete_task"
              ? "completed"
              : input.intent === "cancel_task"
                ? "cancelled"
                : e.status || row.status,
        },
        row.id,
        now,
      );
      return `Task “${result.title}”: ${result.status}.`;
    }
    case "list_tasks": {
      const rows = await tx.task.findMany({
        where: {
          ownerId,
          status:
            e.status && e.status !== "overdue"
              ? e.status
              : { in: ["open", "in_progress"] },
          ...(e.status === "overdue" ? { dueAt: { lt: now } } : {}),
        },
        orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
        take: 15,
      });
      return rows.length
        ? rows
            .map(
              (r) =>
                `P${r.priority} ${r.title} (${r.id})${r.dueAt ? ` — ${displayDate(r.dueAt, zone)}` : ""}`,
            )
            .join("\n")
        : "Belum ada task yang sesuai.";
    }
    case "create_reminder": {
      const row = await saveReminder(
        tx,
        ownerId,
        {
          title: e.title,
          message: e.content,
          scheduledAt: e.date,
          timezone: zone,
          recurrence: e.recurrence || "once",
        },
        undefined,
        now,
      );
      return `Pengingat “${row.title}” dijadwalkan ${displayDate(row.scheduledAt, zone)} (${row.recurrence}). ID: ${row.id}. Status pengiriman belum terkirim.`;
    }
    case "reschedule_reminder":
    case "cancel_reminder": {
      const target = await resolveTarget(tx, ownerId, input);
      const row = await tx.reminder.findUniqueOrThrow({
        where: { id: target.id },
      });
      const result = await saveReminder(
        tx,
        ownerId,
        {
          title: row.title,
          message: row.message,
          scheduledAt: e.date || row.scheduledAt.toISOString(),
          timezone: row.timezone,
          recurrence: e.recurrence || row.recurrence,
          status: input.intent === "cancel_reminder" ? "cancelled" : "active",
          taskId: row.taskId,
        },
        row.id,
        now,
      );
      return result.status === "cancelled"
        ? `Pengingat “${result.title}” dibatalkan.`
        : `Pengingat dijadwalkan ulang: ${displayDate(result.scheduledAt, zone)}.`;
    }
    case "list_reminders": {
      const rows = await tx.reminder.findMany({
        where: { ownerId, status: "active" },
        orderBy: { nextRunAt: "asc" },
        take: 15,
      });
      return rows.length
        ? rows
            .map(
              (r) =>
                `${r.title} — ${displayDate(r.nextRunAt!, zone)} (${r.id})`,
            )
            .join("\n")
        : "Belum ada pengingat aktif.";
    }
    case "create_note": {
      const row = await saveNote(tx, ownerId, {
        title: e.title,
        content: e.content || e.title,
        tags: e.tags || [],
        category: e.category || "general",
        project: e.project,
      });
      return `Catatan “${row.title}” disimpan. ID: ${row.id}.`;
    }
    case "update_note":
    case "archive_note": {
      const target = await resolveTarget(tx, ownerId, input),
        row = await tx.note.findUniqueOrThrow({ where: { id: target.id } });
      await saveNote(
        tx,
        ownerId,
        {
          title: e.title || row.title,
          content: e.content || row.content,
          tags: e.tags || row.tags,
          category: e.category || row.category,
          project: e.project || row.project,
          archived: input.intent === "archive_note",
        },
        row.id,
      );
      return `Catatan “${row.title}” ${input.intent === "archive_note" ? "diarsipkan" : "diperbarui"}.`;
    }
    case "search_notes": {
      const query = e.query || "";
      const rows = await tx.note.findMany({
        where: {
          ownerId,
          archived: false,
          ...(e.category ? { category: e.category } : {}),
          ...(e.tags?.length ? { tags: { hasSome: e.tags } } : {}),
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { content: { contains: query, mode: "insensitive" } },
            { tags: { has: query } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 5,
      });
      return rows.length
        ? rows
            .map((r) => `${r.title}: ${r.content.slice(0, 500)}\nID: ${r.id}`)
            .join("\n\n")
        : "Tidak ditemukan dalam catatan yang disimpan.";
    }
    case "set_budget": {
      const row = await saveBudget(
        tx,
        ownerId,
        {
          month:
            e.month ||
            DateTime.fromJSDate(now).setZone(zone).toFormat("yyyy-MM"),
          category: e.category,
          amount: e.amount,
        },
        now,
        zone,
      );
      return `Anggaran ${row.category} ${row.month}: ${rupiah(row.amount)}.`;
    }
    case "inspect_budget": {
      const rows = await budgetStatus(tx, ownerId, now, zone);
      return rows.length
        ? rows
            .map(
              (r) =>
                `${r.category}: ${rupiah(r.spent)} / ${rupiah(r.amount)} (${r.percent}%)`,
            )
            .join("\n")
        : "Belum ada anggaran bulan ini.";
    }
    case "finance_summary": {
      const result = await financeSummary(
        tx,
        ownerId,
        e.period || "month",
        now,
        zone,
      );
      return result.count
        ? `Dari transaksi tercatat: pemasukan ${rupiah(result.income)}, pengeluaran ${rupiah(result.expense)}.\n${Object.entries(
            result.categories,
          )
            .map(([c, a]) => `${c}: ${rupiah(a)}`)
            .join("\n")}`
        : "Belum ada transaksi yang dicatat pada periode ini.";
    }
    case "agenda":
      return report(tx, ownerId, "daily", now, zone);
    case "daily_review":
      return report(tx, ownerId, "recap", now, zone);
    case "weekly_review":
      return report(tx, ownerId, "weekly", now, zone);
  }
}
export async function confirmAction(
  tx: Tx,
  ownerId: string,
  id: string,
  messageId: string,
  now: Date,
  zone: string,
) {
  const pending = await tx.pendingAction.findFirst({
    where: { id, ownerId, consumedAt: null, expiresAt: { gt: now } },
  });
  if (!pending)
    return "Konfirmasi kedaluwarsa atau sudah digunakan. Kirim ulang permintaan perubahannya.";
  const payload = z
    .object({ intent: intentSchema, targetUpdatedAt: z.string().nullable() })
    .parse(pending.payload);
  if (payload.targetUpdatedAt) {
    const target = await resolveTarget(tx, ownerId, payload.intent);
    if (target.updatedAt.toISOString() !== payload.targetUpdatedAt)
      return "Catatan sudah berubah sejak konfirmasi dibuat. Kirim ulang permintaannya.";
  }
  const consumed = await tx.pendingAction.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (!consumed.count) return "Konfirmasi sudah digunakan.";
  return executeIntent(tx, ownerId, payload.intent, messageId, now, zone, true);
}
