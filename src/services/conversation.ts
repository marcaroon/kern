import { z } from "zod";
import type { Tx } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { intentSchema, type Intent } from "./ai";
import {
  financeSummary,
  saveTransaction,
  voidTransaction,
  saveBudget,
  budgetStatus,
  categoryLabel,
  rupiah,
} from "./finance";
import { latestPending, propose } from "./pending";
import {
  debtInput,
  listDebts,
  saveDebt,
  settleDebts,
  settledText,
} from "./debts";
import {
  billSavedText,
  cancelBill,
  listBills,
  payBill,
  saveBill,
} from "./bills";
import { insightText } from "./insights";
import { handleSplitRequest, receiptDeps, type ReceiptDeps } from "./receipts";
import { saveTask, saveNote, saveReminder, resolveMatch } from "./records";
import { report } from "./reporting";
import { displayDate } from "@/lib/time";
import { DateTime } from "luxon";
import { configured } from "@/lib/config";
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
  "settle_debt",
  "cancel_bill",
]);
// Confirmed intents that act on a person or a bill name instead of a stored record.
const untargeted = new Set(["set_budget", "settle_debt", "cancel_bill"]);
const help = [
  "Hai! 👋 Aku KERN, asisten pribadimu. Ngobrol aja kayak biasa, misalnya:",
  "💸 “makan siang 35rb pakai QRIS” atau “gajian 8jt”",
  "🧾 Kirim foto nota/struk, nanti aku baca dan catat",
  "🍕 Foto nota + caption “split bill: aku nasi goreng, Budi mie ayam”, atau “split 300rb bagi 3”",
  "🤝 “Budi minjem 50rb buat tiket” · “Budi udah bayar” · “siapa aja yang masih utang?”",
  "🔔 “tagihan internet 350rb tiap tanggal 5” · “tagihan bulan ini”",
  "📈 “gimana keuanganku bulan ini?”",
  "✅ “tambah task revisi dashboard”",
  "⏰ “ingatkan besok jam 9 pagi buat follow up vendor”",
  "💡 “catat ide: SaaS klinik hewan”",
  "📊 “pengeluaran minggu ini berapa?” · “agenda hari ini”",
  "Salah catat? Bilang aja “batalkan transaksi tadi”. Untuk perubahan penting aku tanya dulu, cukup balas “ya” atau “batal”.",
].join("\n");

const labels: Record<string, string> = {
  correct_transaction: "koreksi transaksi",
  void_transaction: "batalkan transaksi",
  update_task: "ubah tugas",
  complete_task: "selesaikan tugas",
  cancel_task: "batalkan tugas",
  reschedule_reminder: "ubah jadwal pengingat",
  cancel_reminder: "batalkan pengingat",
  update_note: "ubah catatan",
  archive_note: "arsipkan catatan",
  set_budget: "atur anggaran",
  create_transaction: "catat transaksi",
  create_task: "buat tugas",
  create_note: "simpan catatan",
  create_reminder: "buat pengingat",
  split_bill: "bagi tagihan",
  title: "Judul",
  content: "Isi",
  type: "Jenis",
  amount: "Nominal",
  currency: "Mata uang",
  category: "Kategori",
  paymentMethod: "Pembayaran",
  accountId: "Rekening asal",
  toAccountId: "Rekening tujuan",
  date: "Waktu",
  scheduledAt: "waktu pengingat",
  recurrence: "Pengulangan",
  priority: "Prioritas",
  status: "Status",
  project: "Proyek",
  tags: "Label",
  period: "Periode",
  month: "Bulan",
  income: "pemasukan",
  expense: "pengeluaran",
  transfer: "transfer",
  once: "sekali",
  daily: "setiap hari",
  weekly: "setiap minggu",
  monthly: "setiap bulan",
  open: "belum selesai",
  in_progress: "sedang dikerjakan",
  completed: "selesai",
  cancelled: "dibatalkan",
  settle_debt: "catat pelunasan utang",
  cancel_bill: "hapus tagihan rutin",
  person: "Orang",
  direction: "Arah",
  day: "Tanggal",
  owed_to_me: "dia utang ke kamu",
  i_owe: "kamu utang ke dia",
};

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
  deps: Pick<ReceiptDeps, "plan"> = receiptDeps,
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
      `Boleh lengkapi ${input.missing_fields.map((field) => labels[field]?.toLowerCase() || "detail yang kurang").join(", ") || "pesannya"}? Balas aja detailnya, ya. Belum ada yang aku simpan.`
    );
  if (
    (destructive.has(input.intent) || input.requires_confirmation) &&
    !confirmed
  ) {
    const target =
      untargeted.has(input.intent) || input.intent.startsWith("create_")
        ? null
        : await resolveTarget(tx, ownerId, input);
    if (target) e.id = target.id;
    const pending = await propose(
      tx,
      ownerId,
      {
        intent: input,
        targetUpdatedAt: target?.updatedAt?.toISOString() || null,
      },
      now,
    );
    const changes = Object.entries(e)
      .filter(
        ([key, value]) =>
          value !== null && !["id", "query", "answer"].includes(key),
      )
      .map(
        ([key, value]) =>
          `${labels[key] || key}: ${key === "amount" ? rupiah(String(value)) : key === "date" ? displayDate(new Date(String(value)), zone) : Array.isArray(value) ? value.join(", ") : ["type", "recurrence", "status", "direction"].includes(key) ? labels[String(value)] || String(value) : String(value)}`,
      )
      .join("\n");
    return `Aku akan ${labels[input.intent] || "menjalankan permintaan ini"}${target ? `: “${target.title}”` : ""}. Sudah sesuai?\n${changes.slice(0, 2500)}\nBelum aku ubah. Balas “ya” untuk lanjut atau “batal” (berlaku 10 menit).\nKode konfirmasi: ${pending.id}`;
  }
  switch (input.intent) {
    case "help":
      return help;
    case "general":
      return (
        e.answer || "Mau aku bantu apa? Ketik “bantuan” untuk lihat contoh."
      );
    case "split_bill":
      return handleSplitRequest(tx, ownerId, input, now, deps);
    case "create_debt": {
      if (e.currency && e.currency !== "IDR")
        return "Aku cuma bisa mencatat utang dalam rupiah. Boleh tulis nominal rupiahnya?";
      if (!e.person || !e.direction || !e.amount)
        return "Siapa yang utang ke siapa, dan berapa? Contoh: “Budi minjem 50rb buat tiket” atau “aku utang 100rb ke Sari”.";
      const row = await saveDebt(
        tx,
        ownerId,
        {
          person: e.person,
          direction: e.direction,
          amount: e.amount,
          description: e.title || e.content || "pinjaman",
        },
        now,
      );
      return row.direction === "owed_to_me"
        ? `📝 Dicatat: ${row.person} utang ${rupiah(row.amount)} ke kamu (${row.description}). Nanti aku ingatkan kalau belum kembali dalam 3 hari.`
        : `📝 Dicatat: kamu utang ${rupiah(row.amount)} ke ${row.person} (${row.description}). Aku ingatkan biar nggak lupa bayar.`;
    }
    case "settle_debt":
      return settledText(
        await settleDebts(
          tx,
          ownerId,
          { person: e.person, direction: e.direction, amount: e.amount },
          now,
        ),
      );
    case "list_debts":
      return listDebts(tx, ownerId, e.direction, now);
    case "create_bill": {
      if (!e.title || !e.day)
        return "Tagihan apa dan tiap tanggal berapa? Contoh: “tagihan internet 350rb tiap tanggal 5”.";
      return billSavedText(
        await saveBill(
          tx,
          ownerId,
          {
            name: e.title,
            amount: e.amount,
            dueDay: e.day,
            category: e.category || "bills",
            paymentMethod: e.paymentMethod,
          },
          now,
          zone,
        ),
        zone,
      );
    }
    case "pay_bill":
      return payBill(
        tx,
        ownerId,
        { name: e.title || e.query, amount: e.amount },
        messageId,
        now,
        zone,
      );
    case "list_bills":
      return listBills(tx, ownerId, now, zone);
    case "cancel_bill":
      return cancelBill(tx, ownerId, e.title || e.query);
    case "finance_insight":
      return insightText(tx, ownerId, now, zone);
    case "create_transaction": {
      if (e.currency !== "IDR")
        return "Aku cuma bisa mencatat dalam rupiah (IDR). Boleh tulis nominal rupiahnya?";
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
      const today = DateTime.fromJSDate(row.occurredAt)
        .setZone(zone)
        .hasSame(DateTime.fromJSDate(now).setZone(zone), "day");
      return `✅ Sudah aku catat: ${labels[row.type]} ${rupiah(row.amount)} untuk “${row.description}” (${categoryLabel(row.category)})${today ? "" : `, ${displayDate(row.occurredAt, zone)}`}.${row.paymentMethod ? ` Dibayar lewat ${row.paymentMethod}.` : ""}\n${configured("GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON") ? "Salinan ke spreadsheet menyusul sebentar lagi." : "Tersimpan di KERN (spreadsheet belum terhubung)."}\nID: ${row.id}`;
    }
    case "correct_transaction":
    case "void_transaction": {
      const target = await resolveTarget(tx, ownerId, input);
      if (input.intent === "void_transaction") {
        await voidTransaction(tx, ownerId, target.id, now);
        return `Oke, transaksi “${target.title}” sudah aku batalkan. Riwayatnya tetap tersimpan.`;
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
      return `Sudah aku koreksi: “${e.title || row.description}” sekarang ${rupiah(e.amount || row.amount.toString())}. Versi lamanya tetap tersimpan di riwayat.`;
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
      return `Siap, aku tambahkan “${row.title}” ke daftar tugas${row.dueAt ? ` untuk ${displayDate(row.dueAt, zone)}` : ""}.\nID: ${row.id}`;
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
      return `Sudah aku perbarui: “${result.title}” sekarang ${labels[result.status] || result.status}.`;
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
        ? `Ini daftar tugasmu (${rows.length}):\n${rows
            .map(
              (r) =>
                `${r.priority === 1 ? "🔴" : r.priority === 2 ? "🟡" : "⚪"} ${r.title}${r.dueAt ? ` — ${displayDate(r.dueAt, zone)}` : ""}\n   ID: ${r.id}`,
            )
            .join("\n")}`
        : "Belum ada tugas yang sesuai. Santai dulu 😄";
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
      return `Siap, pengingat “${row.title}” sudah aku jadwalkan untuk ${displayDate(row.scheduledAt, zone)}${row.recurrence === "once" ? "" : `, ${labels[row.recurrence]}`}.\nID: ${row.id}`;
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
        ? `Oke, pengingat “${result.title}” sudah aku batalkan.`
        : `Siap, pengingat “${result.title}” aku pindah ke ${displayDate(result.scheduledAt, zone)}.`;
    }
    case "list_reminders": {
      const rows = await tx.reminder.findMany({
        where: { ownerId, status: "active" },
        orderBy: { nextRunAt: "asc" },
        take: 15,
      });
      return rows.length
        ? `Pengingat yang aktif:\n${rows
            .map(
              (r) =>
                `⏰ ${r.title} — ${displayDate(r.nextRunAt!, zone)}\n   ID: ${r.id}`,
            )
            .join("\n")}`
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
      return `Sudah aku simpan: “${row.title}”. Nanti bisa kamu cari lagi lewat judul atau isinya.\nID: ${row.id}`;
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
      return `Sudah, catatan “${row.title}” ${input.intent === "archive_note" ? "aku arsipkan" : "aku perbarui"}.`;
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
        ? `Ketemu ${rows.length} catatan:\n\n${rows
            .map(
              (r) => `📝 ${r.title}\n${r.content.slice(0, 500)}\nID: ${r.id}`,
            )
            .join("\n\n")}`
        : "Tidak ditemukan dalam catatan yang kamu simpan.";
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
      return `Siap, anggaran ${categoryLabel(row.category)} untuk ${row.month} jadi ${rupiah(row.amount)}.`;
    }
    case "inspect_budget": {
      const rows = await budgetStatus(tx, ownerId, now, zone);
      return rows.length
        ? `Anggaran bulan ini:\n${rows
            .map(
              (r) =>
                `${r.exceeded ? "🔴" : r.warning ? "🟡" : "🟢"} ${categoryLabel(r.category)}: ${rupiah(r.spent)} dari ${rupiah(r.amount)} (${r.percent}%)`,
            )
            .join("\n")}`
        : "Belum ada anggaran bulan ini. Mau bikin? Contoh: “anggaran makan 2jt bulan ini”.";
    }
    case "finance_summary": {
      const result = await financeSummary(
        tx,
        ownerId,
        e.period || "month",
        now,
        zone,
      );
      const period = {
        today: "hari ini",
        week: "minggu ini",
        month: "bulan ini",
        previous_month: "bulan lalu",
      }[e.period || "month"];
      const top = Object.entries(result.categories).sort(([, a], [, b]) =>
        b > a ? 1 : b < a ? -1 : 0,
      );
      return result.count
        ? [
            `Ringkasan ${period} (dari ${result.count} transaksi tercatat):`,
            `💰 Pemasukan: ${rupiah(result.income)}`,
            `💸 Pengeluaran: ${rupiah(result.expense)}`,
            `${result.balance >= 0n ? "📈" : "📉"} Selisih: ${result.balance < 0n ? "-" : ""}${rupiah(result.balance < 0n ? -result.balance : result.balance)}`,
            ...(top.length
              ? [
                  "",
                  "Pengeluaran per kategori:",
                  ...top.map(([c, a]) => `• ${categoryLabel(c)}: ${rupiah(a)}`),
                ]
              : []),
          ].join("\n")
        : `Belum ada transaksi yang tercatat ${period}.`;
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
    return "Konfirmasinya sudah kedaluwarsa atau sudah dipakai. Kirim ulang permintaannya, ya.";
  const payload = z
    .object({
      intent: intentSchema.optional(),
      targetUpdatedAt: z.string().nullable().optional(),
      // Split bills also record who owes whom, atomically with the user's share.
      debts: z.array(debtInput).max(20).optional(),
    })
    .parse(pending.payload);
  if (!payload.intent) {
    await tx.pendingAction.update({ where: { id }, data: { consumedAt: now } });
    if (!payload.debts?.length) return "Oke 👍";
    for (const debt of payload.debts) await saveDebt(tx, ownerId, debt, now);
    return `✅ ${debtsText(payload.debts)}`;
  }
  if (payload.targetUpdatedAt) {
    const target = await resolveTarget(tx, ownerId, payload.intent);
    if (target.updatedAt.toISOString() !== payload.targetUpdatedAt)
      return "Datanya sudah berubah sejak aku tanya tadi, jadi belum aku ubah. Kirim ulang permintaannya, ya.";
  }
  const consumed = await tx.pendingAction.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (!consumed.count) return "Konfirmasi sudah digunakan.";
  const reply = await executeIntent(
    tx,
    ownerId,
    payload.intent,
    messageId,
    now,
    zone,
    true,
  );
  if (!payload.debts?.length) return reply;
  for (const debt of payload.debts) await saveDebt(tx, ownerId, debt, now);
  return `${reply}\n${debtsText(payload.debts)}`;
}
function debtsText(
  debts: { person: string; direction: string; amount: string }[],
) {
  const owed = debts.filter((d) => d.direction === "owed_to_me");
  const mine = debts.filter((d) => d.direction === "i_owe");
  return [
    ...(owed.length
      ? [
          `Piutang dicatat: ${owed.map((d) => `${d.person} ${rupiah(d.amount)}`).join(", ")}. Aku ingatkan kalau belum dibayar dalam 3 hari.`,
        ]
      : []),
    ...mine.map(
      (d) => `Utangmu ke ${d.person} ${rupiah(d.amount)} juga aku catat.`,
    ),
  ].join("\n");
}
// "batal <id>" from a button cancels that specific proposal.
export async function cancelProposal(
  tx: Tx,
  ownerId: string,
  id: string,
  now: Date,
) {
  const cancelled = await tx.pendingAction.updateMany({
    where: { id, ownerId, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  return cancelled.count
    ? "Oke, nggak jadi. Belum ada yang aku ubah."
    : "Pertanyaan itu sudah nggak berlaku, jadi nggak ada yang berubah.";
}

// "ya" / "batal" answer the latest open proposal. Null means none is open, so the
// message is treated as an ordinary request instead.
const yes =
  /^(ya+|iya+|iy|y|yes|ok(e|ey)?|okay|sip|siap|simpan|lanjut(kan)?|gas|betul|benar|bener|setuju|confirm|konfirmasi)[!. ]*$/i;
const no =
  /^(batal(kan)?|tidak|nggak|ngga|gak|ga|no|cancel|jangan|(gak|ga|nggak|tidak) jadi)[!. ]*$/i;
export async function answerProposal(
  tx: Tx,
  ownerId: string,
  text: string,
  messageId: string,
  now: Date,
  zone: string,
): Promise<string | null> {
  const answer = text.trim();
  if (!yes.test(answer) && !no.test(answer)) return null;
  const pending = await latestPending(tx, ownerId, now);
  if (!pending) return null;
  if (no.test(answer)) {
    await tx.pendingAction.update({
      where: { id: pending.id },
      data: { consumedAt: now },
    });
    return "Oke, nggak jadi. Belum ada yang aku ubah.";
  }
  return confirmAction(tx, ownerId, pending.id, messageId, now, zone);
}
