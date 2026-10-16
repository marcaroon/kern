import {
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { readFile, readdir } from "node:fs/promises";
import {
  saveTransaction,
  voidTransaction,
  saveBudget,
  financeSummary,
} from "@/services/finance";
import { saveTask, saveReminder, saveNote } from "@/services/records";
import { ingestUpdates, pollUpdates } from "@/integrations/telegram";
import { processInbox, type VoiceDeps } from "@/services/inbox";
import { habitCheckins } from "@/services/habits";
import { embedPendingNotes, similarNotes } from "@/services/semantic";
import { fallback, intent, type Intent, type Turn } from "@/services/ai";
import { debtNudges } from "@/services/debts";
import { billReminders } from "@/services/bills";
import { report } from "@/services/reporting";
import { planSplit, type ReceiptDeps } from "@/services/receipts";
import { AppError } from "@/lib/errors";
import { executeIntent, confirmAction } from "@/services/conversation";
import { materializeReminders } from "@/services/reminders";
import { dispatchMessages, DeliveryError, enqueue } from "@/services/queue";
import { syncSheets } from "@/services/sheets";
import { sheetHeaders, type SheetPort } from "@/integrations/sheets";
vi.mock("@/lib/auth", () => ({
  requireOwner: async () => "11111111-1111-4111-8111-111111111111",
}));
import { handleApi } from "@/controllers/api";
import { receiveTelegram } from "@/controllers/webhook";
import { automate, schedulerAlert } from "@/services/automation";
import { integrationHealth } from "@/services/health";

const owner = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-12T01:00:00Z");
let pg: PGlite, server: PGLiteSocketServer, db: PrismaClient;
beforeAll(async () => {
  pg = await PGlite.create();
  const dirs = (
    await readdir("prisma/migrations", { withFileTypes: true })
  ).filter((d) => d.isDirectory());
  for (const dir of dirs.sort((a, b) => a.name.localeCompare(b.name)))
    await pg.exec(
      await readFile(`prisma/migrations/${dir.name}/migration.sql`, "utf8"),
    );
  server = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await server.start();
  db = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: `postgresql://postgres:postgres@${server.getServerConn()}/postgres`,
      max: 1,
    }),
  });
  (globalThis as unknown as { kernDb?: PrismaClient }).kernDb = db;
});
afterAll(async () => {
  await db?.$disconnect();
  await server?.stop();
  await pg?.close();
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "AuditLog", "Debt", "Bill", "Goal", "HabitLog", "Habit", "BudgetAlert", "Budget", "SheetSyncOutbox", "Transaction", "Account", "Reminder", "Task", "Note", "PendingAction", "Job", "InboxMessage", "Heartbeat" RESTART IDENTITY CASCADE',
  );
});
const transaction = (amount = "35000") => ({
  type: "expense",
  amount,
  occurredAt: now.toISOString(),
  category: "food",
  description: "Makan siang",
  paymentMethod: "QRIS",
});
const ownerChat = 1001;
let updateId = 1;
const update = (
  messageId = 1,
  body: string | null = "Catat pengeluaran 35 ribu buat makan siang QRIS.",
  from = ownerChat,
  chat: { id: number; type: string } = { id: from, type: "private" },
  isBot = false,
) => ({
  update_id: updateId++,
  message: {
    message_id: messageId,
    date: now.getTime() / 1000,
    chat,
    from: { id: from, is_bot: isBot },
    ...(body === null ? {} : { text: body }),
  },
});
const ingest = (...updates: unknown[]) =>
  ingestUpdates(db, updates, owner, [String(ownerChat)], now);
const parse = async (text: string) => fallback(text, now);
describe("API mutations and additional failure paths", () => {
  it("rejects malformed money and foreign origins without writing", async () => {
    const context = { params: Promise.resolve({ resource: "transactions" }) };
    const request = (origin: string, amount: string) =>
      new Request("http://localhost:3000/api/transactions", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(transaction(amount)),
      });
    expect(
      (await handleApi(request("https://evil.example", "35000"), context))
        .status,
    ).toBe(403);
    expect(
      (await handleApi(request("http://localhost:3000", "1.5"), context))
        .status,
    ).toBe(422);
    expect(await db.transaction.count()).toBe(0);
  });
  it("saves and corrects through HTTP controllers, rejects stale versions", async () => {
    const req = (method: string, body: unknown) =>
      new Request("http://localhost:3000/api/transactions", {
        method,
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const created = await handleApi(req("POST", transaction()), {
      params: Promise.resolve({ resource: "transactions" }),
    });
    expect(created.status).toBe(201);
    const { data: row } = await created.json();
    const context = {
      params: Promise.resolve({ resource: "transactions", id: [row.id] }),
    };
    const body = {
      ...transaction("40000"),
      confirmed: true,
      expectedUpdatedAt: row.updatedAt,
    };
    expect((await handleApi(req("PATCH", body), context)).status).toBe(200);
    expect((await handleApi(req("PATCH", body), context)).status).toBe(409);
  });
  it("ends known-rejection retries after five attempts", async () => {
    await db.$transaction((tx) =>
      enqueue(tx, owner, "bounded-retry", { text: "test" }, now),
    );
    const send = vi
      .fn()
      .mockRejectedValue(new DeliveryError("META_RATE_LIMIT", "retry"));
    for (let i = 0; i < 7; i++)
      await dispatchMessages(db, send, new Date(now.getTime() + i * 3600000));
    expect(send).toHaveBeenCalledTimes(5);
    expect((await db.job.findFirstOrThrow()).status).toBe("failed");
  });
  it("marks a crashed send uncertain and blocks it from automatic redelivery", async () => {
    const job = await db.$transaction((tx) =>
      enqueue(tx, owner, "crashed-send", { text: "test" }, now),
    );
    await db.job.update({
      where: { id: job.id },
      data: {
        status: "processing",
        claimedAt: new Date(now.getTime() - 180000),
      },
    });
    const send = vi.fn();
    await dispatchMessages(db, send, now);
    expect(send).not.toHaveBeenCalled();
    expect((await db.job.findFirstOrThrow()).status).toBe("uncertain");
  });
  it("never writes an ambiguous financial request", async () => {
    await ingest(update(7, "pengeluaran 35 atau 40 ribu makan"));
    await processInbox(db, now, "Asia/Jakarta", parse);
    expect(await db.transaction.count()).toBe(0);
  });
});
describe("migrated PostgreSQL domain services", () => {
  it("commits exact transaction, audit and outbox together; void updates summary", async () => {
    const row = await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction("9007199254740993"), { now }),
    );
    expect(row.amount).toBe(9007199254740993n);
    expect(await db.sheetSyncOutbox.count()).toBe(1);
    expect(await db.auditLog.count()).toBe(1);
    await db.$transaction((tx) => voidTransaction(tx, owner, row.id, now));
    expect((await financeSummary(db, owner, "month", now)).expense).toBe(0n);
    expect(await db.sheetSyncOutbox.count()).toBe(2);
  });
  it("rolls back outbox and transaction on failure", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await saveTransaction(tx, owner, transaction(), { now });
        throw new Error("fail");
      }),
    ).rejects.toThrow();
    expect(await db.transaction.count()).toBe(0);
    expect(await db.sheetSyncOutbox.count()).toBe(0);
  });
  it("isolates owners and prevents unowned transfer accounts", async () => {
    const account = await db.account.create({
      data: { ownerId: "another-owner", name: "Private" },
    });
    await expect(
      db.$transaction((tx) =>
        saveTransaction(
          tx,
          owner,
          { ...transaction(), accountId: account.id },
          { now },
        ),
      ),
    ).rejects.toThrow("ACCOUNT_NOT_FOUND");
    await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction(), { now }),
    );
    expect(
      (await financeSummary(db, "another-owner", "month", now)).count,
    ).toBe(0);
  });
  it("sends each budget threshold alert once, not on every further expense", async () => {
    await db.$transaction((tx) =>
      saveBudget(
        tx,
        owner,
        {
          month: "2026-10",
          category: "food",
          amount: "100000",
          warningPercent: 80,
        },
        now,
      ),
    );
    for (const amount of ["80000", "10000", "10000", "10000"])
      await db.$transaction((tx) =>
        saveTransaction(tx, owner, transaction(amount), { now }),
      );
    expect(await db.budgetAlert.count()).toBe(2);
    expect(await db.job.count()).toBe(2);
  });
  it("corrects records with audit history and fresh outbox revision", async () => {
    const row = await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction(), { now }),
    );
    await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction("40000"), { id: row.id, now }),
    );
    expect((await financeSummary(db, owner, "month", now)).expense).toBe(
      40000n,
    );
    expect(
      await db.auditLog.count({ where: { action: "transaction.correct" } }),
    ).toBe(1);
    expect(await db.sheetSyncOutbox.count()).toBe(2);
  });
});
describe("Telegram durable inbox and conversations", () => {
  it("deduplicates webhook delivery, actions and queued replies", async () => {
    for (let i = 0; i < 3; i++) await ingest(update(1));
    await processInbox(db, now, "Asia/Jakarta", parse);
    await processInbox(db, now, "Asia/Jakarta", parse);
    expect(await db.inboxMessage.count()).toBe(1);
    expect(await db.transaction.count()).toBe(1);
    expect(await db.job.count()).toBe(1);
    const reply = (await db.job.findFirstOrThrow()).payload as { text: string };
    expect(reply.text).toContain("Rp35.000");
    expect(reply.text).toContain("Makan & Minum");
  });
  it("ignores strangers, groups, bots and malformed updates", async () => {
    const result = await ingest(
      update(1, "halo", 2002),
      update(2, "halo", ownerChat, { id: -5, type: "group" }),
      update(3, "halo", ownerChat, { id: ownerChat, type: "private" }, true),
      { update_id: 99, message: { message_id: "x" } },
      { update_id: 100, edited_message: {} },
    );
    expect(result.accepted).toBe(0);
    expect(await db.inboxMessage.count()).toBe(0);
  });
  it("replies to the sending chat and answers unsupported media honestly", async () => {
    await ingest(update(4, null));
    await processInbox(db, now, "Asia/Jakarta", parse);
    expect((await db.job.findFirstOrThrow()).payload).toMatchObject({
      chatId: String(ownerChat),
      text: expect.stringContaining("teks"),
    });
  });
  it("confirms polled updates only after they are stored", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-only");
    vi.stubEnv("TELEGRAM_OWNER_USER_ID", String(ownerChat));
    const pending = [update(10), update(11, "Tambah task revisi dashboard")];
    const bodies: Record<string, unknown>[] = [];
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }));
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return body.offset ? ok([]) : ok(pending);
    }) as unknown as typeof fetch;
    expect(await pollUpdates(db, owner, transport, now)).toEqual({
      received: 2,
      accepted: 2,
    });
    expect(bodies[1].offset).toBe(pending[1].update_id + 1);
    // Redelivery after a crash before confirmation stores nothing twice.
    await pollUpdates(db, owner, transport, now);
    expect(await db.inboxMessage.count()).toBe(2);
    // A failed inbox write must not confirm (and thereby lose) the updates.
    bodies.length = 0;
    const spy = vi
      .spyOn(db.inboxMessage, "createMany")
      .mockRejectedValueOnce(new Error("db down"));
    await expect(pollUpdates(db, owner, transport, now)).rejects.toThrow();
    expect(bodies.some((b) => b.offset)).toBe(false);
    spy.mockRestore();
    vi.unstubAllEnvs();
  });
  it("asks for missing schedule and creates no invalid reminder", async () => {
    await ingest(update(5, "Ingatkan gue bayar tagihan."));
    await processInbox(db, now, "Asia/Jakarta", parse);
    expect(await db.reminder.count()).toBe(0);
    expect((await db.job.findFirstOrThrow()).payload).toMatchObject({
      text: expect.stringContaining("kapan"),
    });
  });
  it("creates expense, task, reminder and note through the same durable pipeline", async () => {
    const messages = [
      "Pengeluaran 35000 makan siang QRIS",
      "Tambah task revisi dashboard",
      "Ingatkan gue besok jam 9 pagi buat follow up vendor",
      "Catat ide bikin SaaS untuk klinik hewan",
    ];
    for (const [i, message] of messages.entries())
      await ingest(update(20 + i, message));
    await processInbox(db, now, "Asia/Jakarta", parse);
    expect(await db.transaction.count()).toBe(1);
    expect(await db.task.count()).toBe(1);
    expect(await db.reminder.count()).toBe(1);
    expect(await db.note.count()).toBe(1);
  });
  it("does not mutate ambiguous tasks and completes one explicit target", async () => {
    for (const title of ["Follow up vendor A", "Follow up vendor B"])
      await db.$transaction((tx) =>
        saveTask(tx, owner, { title }, undefined, now),
      );
    await expect(
      db.$transaction((tx) =>
        executeIntent(
          tx,
          owner,
          intent("complete_task", { query: "vendor" }),
          "m",
          now,
          "Asia/Jakarta",
        ),
      ),
    ).rejects.toThrow("Ada beberapa");
    const target = await db.task.findFirstOrThrow();
    await db.$transaction((tx) =>
      executeIntent(
        tx,
        owner,
        intent("complete_task", { id: target.id }),
        "m2",
        now,
        "Asia/Jakarta",
      ),
    );
    expect(
      await db.task.count({ where: { status: "completed", completedAt: now } }),
    ).toBe(1);
  });
  it("requires single-use expiring confirmation for financial voiding", async () => {
    const row = await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction(), { now }),
    );
    const reply = await db.$transaction((tx) =>
      executeIntent(
        tx,
        owner,
        intent("void_transaction", { id: row.id }),
        "m",
        now,
        "Asia/Jakarta",
      ),
    );
    expect(reply).toContain("konfirmasi");
    expect(reply).toContain("Aku akan batalkan transaksi");
    expect(reply).not.toContain("void_transaction");
    expect(
      (await db.transaction.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("active");
    const pending = await db.pendingAction.findFirstOrThrow();
    await db.$transaction((tx) =>
      confirmAction(tx, owner, pending.id, "m2", now, "Asia/Jakarta"),
    );
    expect(
      (await db.transaction.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("void");
    expect(
      await db.$transaction((tx) =>
        confirmAction(tx, owner, pending.id, "m3", now, "Asia/Jakarta"),
      ),
    ).toContain("sudah dipakai");
  });
  it("does not fabricate a memory", async () => {
    expect(
      await db.$transaction((tx) =>
        executeIntent(
          tx,
          owner,
          intent("search_notes", { query: "ESP32" }),
          "m",
          now,
          "Asia/Jakarta",
        ),
      ),
    ).toContain("Tidak ditemukan");
  });
  it("keeps user text intact while translating confirmation labels", async () => {
    const reply = await db.$transaction((tx) =>
      executeIntent(
        tx,
        owner,
        intent(
          "create_task",
          { title: "completed" },
          { requires_confirmation: true },
        ),
        "preview",
        now,
        "Asia/Jakarta",
      ),
    );
    expect(reply).toContain("Judul: completed");
    expect(reply).not.toContain("Judul: selesai");
    expect(await db.task.count()).toBe(0);
  });
});
describe("persistent reminders and outbound retry", () => {
  async function dueReminder() {
    return db.$transaction((tx) =>
      saveReminder(
        tx,
        owner,
        {
          title: "Vendor",
          scheduledAt: now.toISOString(),
          recurrence: "daily",
        },
        undefined,
        new Date(now.getTime() - 60000),
      ),
    );
  }
  it("materializes one occurrence and never resends accepted jobs", async () => {
    const reminder = await dueReminder();
    await materializeReminders(db, now);
    await materializeReminders(db, now);
    expect(await db.job.count()).toBe(1);
    const send = vi.fn().mockResolvedValue("provider-1");
    await dispatchMessages(db, send, now);
    await dispatchMessages(db, send, now);
    expect(send).toHaveBeenCalledTimes(1);
    const stored = await db.reminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });
    expect(stored.deliveryStatus).toBe("accepted");
    expect(stored.lastDeliveredAt).toBeNull();
    expect(stored.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
  });
  it("retries explicit rate-limit rejection with bounded backoff", async () => {
    await dueReminder();
    await materializeReminders(db, now);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new DeliveryError("META_RATE_LIMIT", "retry"))
      .mockResolvedValue("provider-2");
    await dispatchMessages(db, send, now);
    await dispatchMessages(db, send, now);
    expect(send).toHaveBeenCalledTimes(1);
    await dispatchMessages(db, send, new Date(now.getTime() + 60000));
    expect(send).toHaveBeenCalledTimes(2);
    expect((await db.job.findFirstOrThrow()).status).toBe("accepted");
  });
  it("does not retry ambiguous timeouts or configuration blocks automatically", async () => {
    await db.$transaction((tx) =>
      enqueue(tx, owner, "unknown-send", { text: "hello" }, now),
    );
    const send = vi
      .fn()
      .mockRejectedValue(new DeliveryError("META_SEND_UNCERTAIN", "uncertain"));
    await dispatchMessages(db, send, now);
    await dispatchMessages(db, send, new Date(now.getTime() + 999999));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.job.findFirstOrThrow()).status).toBe("uncertain");
  });
  it("cancels queued occurrences when a reminder is cancelled", async () => {
    const r = await dueReminder();
    await materializeReminders(db, now);
    await db.$transaction((tx) =>
      saveReminder(
        tx,
        owner,
        {
          title: r.title,
          scheduledAt: r.scheduledAt.toISOString(),
          status: "cancelled",
        },
        r.id,
        now,
      ),
    );
    const send = vi.fn();
    await dispatchMessages(db, send, now);
    expect(send).not.toHaveBeenCalled();
  });
});
describe("Google Sheets outbox under partial failure", () => {
  function fakeSheet() {
    const rows = new Map<number, string[]>();
    let loseResponse = false;
    const sheet: SheetPort = {
      async read(range) {
        if (range === "Transactions!A1:L1") return [sheetHeaders];
        if (range === "Transactions!A2:A") {
          const max = Math.max(1, ...rows.keys());
          return Array.from({ length: max - 1 }, (_, i) => [
            rows.get(i + 2)?.[0] || "",
          ]);
        }
        const index = Number(range.match(/!A(\d+)/)?.[1]);
        return rows.has(index) ? [rows.get(index)!] : [];
      },
      async write(range, values) {
        rows.set(Number(range.match(/!A(\d+)/)?.[1]), values[0]);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("response lost after write");
        }
      },
    };
    return {
      rows,
      sheet,
      loseNextResponse() {
        loseResponse = true;
      },
    };
  }
  it("keeps financial data and retries same row after successful write with lost response", async () => {
    await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction(), { now }),
    );
    const fake = fakeSheet();
    fake.loseNextResponse();
    await syncSheets(db, now, fake.sheet);
    expect((await db.sheetSyncOutbox.findFirstOrThrow()).status).toBe("retry");
    expect(await db.transaction.count()).toBe(1);
    await syncSheets(db, new Date(now.getTime() + 60000), fake.sheet);
    expect(fake.rows.size).toBe(1);
    expect((await db.sheetSyncOutbox.findFirstOrThrow()).status).toBe("synced");
  });
  it("syncs the latest revision and void to the original row", async () => {
    const row = await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction(), { now }),
    );
    const fake = fakeSheet();
    await db.$transaction((tx) => voidTransaction(tx, owner, row.id, now));
    await syncSheets(db, now, fake.sheet);
    expect(fake.rows.size).toBe(1);
    expect([...fake.rows.values()][0][8]).toBe("void");
    expect(
      await db.sheetSyncOutbox.count({ where: { status: "synced" } }),
    ).toBe(2);
  });
  it("syncs at most the requested number of events per run", async () => {
    for (const amount of ["1000", "2000", "3000"])
      await db.$transaction((tx) =>
        saveTransaction(tx, owner, transaction(amount), { now }),
      );
    const rows = new Map<string, string[][]>();
    rows.set("Transactions!A1:L1", [sheetHeaders]);
    const port: SheetPort = {
      read: async (range) => rows.get(range) ?? [],
      write: async (range, values) => {
        rows.set(range, values);
      },
    };
    expect((await syncSheets(db, now, port, 2)).processed).toBe(2);
    expect(
      await db.sheetSyncOutbox.count({ where: { status: "synced" } }),
    ).toBe(2);
    expect((await syncSheets(db, now, port, 2)).processed).toBe(1);
  });
  it("retains pending events when the optional integration is absent", async () => {
    await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction(), { now }),
    );
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "");
    expect((await syncSheets(db, now)).status).toBe("not_configured");
    expect((await db.sheetSyncOutbox.findFirstOrThrow()).status).toBe(
      "pending",
    );
    vi.unstubAllEnvs();
  });
  it("preserves occupied cells even when their transaction ID is blank", async () => {
    const row = await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction(), { now }),
    );
    const fake = fakeSheet();
    const existing = ["", "manual data to preserve"];
    fake.rows.set(row.sheetRow + 1, existing);
    await syncSheets(db, now, fake.sheet);
    expect(fake.rows.get(row.sheetRow + 1)).toEqual(existing);
    expect(await db.sheetSyncOutbox.findFirstOrThrow()).toMatchObject({
      status: "retry",
      lastError: "SHEETS_ROW_CONFLICT",
    });
  });
});
describe("serverless webhook and scheduler", () => {
  const secret = "s".repeat(32);
  function hosted() {
    vi.stubEnv("TELEGRAM_MODE", "webhook");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", secret);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-only");
    vi.stubEnv("TELEGRAM_OWNER_USER_ID", String(ownerChat));
    vi.stubEnv("KERN_OWNER_SUPABASE_USER_ID", owner);
    for (const name of [
      "AI_PROVIDER",
      "GROQ_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
    ])
      vi.stubEnv(name, "");
  }
  it("stores, executes and answers a webhook message in the same request", async () => {
    hosted();
    // A running scheduler, so no stopped-scheduler alert is sent.
    await db.heartbeat.create({ data: { name: "tick", at: new Date() } });
    const sent = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 9 } })),
    );
    vi.stubGlobal("fetch", sent);
    const post = () =>
      receiveTelegram(
        new Request("http://localhost/api/webhooks/telegram", {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
          body: JSON.stringify(update(40)),
        }),
      );
    expect((await post()).status).toBe(200);
    expect(await db.transaction.count()).toBe(1);
    expect((await db.job.findFirstOrThrow()).status).toBe("accepted");
    expect(sent).toHaveBeenCalledTimes(1);
    // Telegram redelivering the same update repeats neither the action nor the reply.
    expect((await post()).status).toBe(200);
    expect(await db.transaction.count()).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("keeps the message for the scheduler when the reply cannot be processed", async () => {
    hosted();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const response = await receiveTelegram(
      new Request("http://localhost/api/webhooks/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify(update(41)),
      }),
    );
    expect(response.status).toBe(200);
    expect(await db.transaction.count()).toBe(1);
    expect((await db.job.findFirstOrThrow()).status).toBe("uncertain");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("bounds webhook processing and leaves the remaining inbox for the scheduler", async () => {
    hosted();
    let sentId = 10;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, result: { message_id: sentId++ } }),
          ),
      ),
    );
    try {
      await ingest(update(50), update(51));
      await automate(db, "reply", now);
      expect(
        await db.inboxMessage.count({ where: { status: "processed" } }),
      ).toBe(1);
      expect(
        await db.inboxMessage.count({ where: { status: "pending" } }),
      ).toBe(1);
      expect(await db.transaction.count()).toBe(1);
      await automate(db, "dispatch", now);
      expect(
        await db.inboxMessage.count({ where: { status: "processed" } }),
      ).toBe(2);
      expect(await db.transaction.count()).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("fires daily and weekly reports once inside their WIB windows", async () => {
    hosted();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    // Sunday 18 October 2026, WIB = UTC+7.
    const at = (hhmm: string) => new Date(`2026-10-18T${hhmm}:00+07:00`);
    const reports = () =>
      db.job.count({ where: { key: { startsWith: "report:" } } });
    await automate(db, "tick", at("06:59"));
    expect(await reports()).toBe(0);
    await automate(db, "tick", at("07:00"));
    await automate(db, "tick", at("07:14"));
    expect(await reports()).toBe(1);
    await automate(db, "tick", at("07:15"));
    expect(await reports()).toBe(1);
    await automate(db, "tick", at("20:03"));
    await automate(db, "tick", at("20:04"));
    expect(await reports()).toBe(2);
    expect(
      (await db.heartbeat.findUniqueOrThrow({ where: { name: "tick" } })).at,
    ).toEqual(at("20:04"));
    const keys = (await db.job.findMany({ select: { key: true } })).map(
      (j) => j.key,
    );
    expect(keys.some((k) => k.includes(":weekly:"))).toBe(true);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("warns the owner once a day when the scheduler stops, via webhook traffic", async () => {
    hosted();
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)).text);
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: sent.length } }),
        );
      }),
    );
    try {
      const at = new Date();
      await db.heartbeat.create({
        data: { name: "tick", at: new Date(at.getTime() - 3 * 86400000) },
      });
      await ingest(update(60));
      const result = (await automate(db, "reply", at)) as {
        sheets: { status: string };
      };
      expect(result.sheets.status).toBe("not_configured");
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain("Rp35.000");
      expect(sent[1]).toContain("Scheduler KERN tidak jalan sejak");
      await ingest(update(61));
      await automate(db, "reply", new Date(at.getTime() + 60000));
      expect(sent.filter((t) => t.includes("Scheduler KERN"))).toHaveLength(1);
      // Once the scheduler runs again, nothing is reported.
      await db.heartbeat.update({
        where: { name: "tick" },
        data: { at: new Date(at.getTime() + 120000) },
      });
      expect(
        (
          await schedulerAlert(
            db,
            new Date(at.getTime() + 180000),
            "Asia/Jakarta",
          )
        ).alerted,
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("reports whether the external scheduler ran recently", async () => {
    const health = () => integrationHealth(db, owner);
    expect((await health()).integrations.scheduler).toBe(false);
    expect((await health()).schedulerLastRunAt).toBeNull();
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await db.heartbeat.create({ data: { name: "tick", at: stale } });
    expect((await health()).integrations.scheduler).toBe(false);
    expect((await health()).schedulerLastRunAt).toEqual(stale);
    await db.heartbeat.update({
      where: { name: "tick" },
      data: { at: new Date() },
    });
    expect((await health()).integrations.scheduler).toBe("berjalan");
  });
});
describe("receipt photos, split bill and conversation", () => {
  const photo = (messageId: number, caption?: string, size = 200000) => ({
    update_id: updateId++,
    message: {
      message_id: messageId,
      date: now.getTime() / 1000,
      chat: { id: ownerChat, type: "private" },
      from: { id: ownerChat, is_bot: false },
      photo: [
        { file_id: "small", file_size: 1000, width: 90, height: 90 },
        { file_id: "large", file_size: size, width: 1280, height: 960 },
      ],
      ...(caption ? { caption } : {}),
    },
  });
  const reading = {
    is_receipt: true,
    type: "expense" as const,
    merchant: "Warung Bu Sri",
    date: null,
    currency: "IDR",
    items: [
      { name: "Nasi goreng", quantity: 1, amount: "25000" },
      { name: "Mie ayam", quantity: 1, amount: "20000" },
      { name: "Es teh", quantity: 2, amount: "10000" },
    ],
    subtotal: "55000",
    tax: "5500",
    service: null,
    discount: null,
    total: "60500",
    payment_method: "QRIS",
    category: "food",
    problem: null,
  };
  const media = (overrides: Partial<ReceiptDeps> = {}): ReceiptDeps => ({
    download: vi.fn(async () => Buffer.from("image")),
    read: vi.fn(async () => reading),
    plan: planSplit,
    ...overrides,
  });
  const run = (
    deps: ReceiptDeps,
    parser: Parameters<typeof processInbox>[3] = parse,
  ) => processInbox(db, now, "Asia/Jakarta", parser, 10, deps);
  const replies = async () =>
    (await db.job.findMany({ orderBy: { createdAt: "asc" } })).map(
      (j) => (j.payload as { text: string }).text,
    );
  function noAi() {
    for (const name of [
      "AI_PROVIDER",
      "GROQ_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
    ])
      vi.stubEnv(name, "");
  }
  afterEach(() => vi.unstubAllEnvs());

  it("stores only the Telegram file reference of a photo, never the image", async () => {
    await ingest(photo(60, "makan siang"), photo(61, undefined, 9_000_000));
    const rows = await db.inboxMessage.findMany({ orderBy: { id: "asc" } });
    expect(rows[0]).toMatchObject({
      text: "makan siang",
      fileId: "large",
      fileMime: "image/jpeg",
    });
    // The oversized size is skipped in favour of the largest one that fits.
    expect(rows[1]).toMatchObject({ fileId: "small" });
  });
  it("proposes a receipt and records it only after a plain “ya”", async () => {
    const deps = media();
    await ingest(photo(62));
    await run(deps);
    expect(await db.transaction.count()).toBe(0);
    expect(deps.download).toHaveBeenCalledWith("large");
    expect((await replies())[0]).toContain("Rp60.500");
    expect((await replies())[0]).toContain("Balas “ya”");
    await ingest(update(63, "ya"));
    await run(deps);
    const row = await db.transaction.findFirstOrThrow();
    expect(row).toMatchObject({
      amount: 60500n,
      description: "Warung Bu Sri",
      category: "food",
      paymentMethod: "QRIS",
      source: "telegram",
    });
    expect(await db.sheetSyncOutbox.count()).toBe(1);
    // A second "ya" has nothing to confirm and never records twice.
    await ingest(update(64, "ya"));
    await run(deps);
    expect(await db.transaction.count()).toBe(1);
  });
  it("drops the proposal on “batal” and honestly rejects non-receipts", async () => {
    await ingest(photo(65));
    await run(media());
    await ingest(update(66, "batal"));
    await run(media());
    expect(await db.transaction.count()).toBe(0);
    expect((await replies())[1]).toContain("nggak jadi");
    await ingest(photo(67));
    await run(
      media({ read: vi.fn(async () => ({ ...reading, is_receipt: false })) }),
    );
    expect((await replies())[2]).toContain("bukan nota");
    expect(await db.pendingAction.count({ where: { consumedAt: null } })).toBe(
      0,
    );
  });
  it("answers provider and currency failures without writing", async () => {
    await ingest(photo(68), photo(69));
    let calls = 0;
    await run(
      media({
        read: vi.fn(async () => {
          if (calls++ === 0)
            throw new AppError("VISION_UNAVAILABLE", 503, "lagi gagal membaca");
          return { ...reading, currency: "USD" };
        }),
      }),
    );
    const texts = await replies();
    expect(texts[0]).toContain("lagi gagal membaca");
    expect(texts[1]).toContain("rupiah");
    expect(await db.pendingAction.count()).toBe(0);
    expect(
      await db.inboxMessage.count({ where: { status: "processed" } }),
    ).toBe(2);
  });
  it("splits a captioned receipt and records only the user's share", async () => {
    const plan = vi.fn(async () => ({
      participants: ["aku", "Budi"],
      assignments: [
        { item: 1, people: ["aku"] },
        { item: 2, people: ["Budi"] },
      ],
      payer: null,
      question: null,
    }));
    await ingest(photo(70, "split bill: aku nasi goreng, Budi mie ayam"));
    await run(media({ plan }));
    const text = (await replies())[0];
    expect(text).toContain("Kamu: Rp33.000");
    expect(text).toContain("Budi: Rp27.500");
    expect(text).toContain("Dibagi rata: Es teh");
    await ingest(update(71, "oke"));
    await run(media({ plan }));
    expect(await db.transaction.findFirstOrThrow()).toMatchObject({
      amount: 33000n,
      description: "Bagianku: Warung Bu Sri",
    });
  });
  it("splits the last receipt from a text follow-up and supersedes the total", async () => {
    noAi();
    await ingest(photo(72));
    await run(media());
    await ingest(update(73, "bagi rata 3 orang"));
    await run(media());
    expect((await replies())[1]).toContain("Rp20.167");
    await ingest(update(74, "ya"));
    await run(media());
    const rows = await db.transaction.findMany();
    expect(rows.map((r) => r.amount)).toEqual([20167n]);
  });
  it("splits a stated total without a receipt, and asks when there is none", async () => {
    noAi();
    await ingest(update(75, "split 300rb bagi 3"));
    await run(media());
    expect((await replies())[0]).toContain("Kamu: Rp100.000");
    await ingest(update(76, "ya"));
    await run(media());
    expect((await db.transaction.findFirstOrThrow()).amount).toBe(100000n);
    await ingest(update(77, "bagi rata 4 orang"));
    await run(media());
    expect((await replies())[2]).toContain("Kirim foto notanya");
  });
  it("gives the parser recent turns so follow-ups keep context", async () => {
    const seen: Turn[][] = [];
    const parser = async (
      text: string,
      at: Date,
      zone: string,
      history: Turn[],
    ) => {
      seen.push(history);
      return fallback(text, at, zone);
    };
    await db.inboxMessage.create({
      data: {
        id: "tg:other:1",
        ownerId: "another-owner",
        sender: "3003",
        text: "rahasia orang lain",
        receivedAt: now,
        status: "processed",
      },
    });
    await ingest(update(78, "Pengeluaran 35000 makan siang QRIS"));
    await run(media(), parser);
    await ingest(update(79, "halo"));
    await run(media(), parser);
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([
      {
        user: "Pengeluaran 35000 makan siang QRIS",
        reply: expect.stringContaining("Rp35.000"),
      },
    ]);
    // Another owner's messages never appear in the context.
    expect(JSON.stringify(seen)).not.toContain("rahasia");
  });
  it("keeps one live proposal so “ya” is never ambiguous", async () => {
    const row = await db.$transaction((tx) =>
      saveTransaction(tx, owner, transaction(), { now }),
    );
    await db.$transaction((tx) =>
      executeIntent(
        tx,
        owner,
        intent("void_transaction", { id: row.id }),
        "a",
        now,
        "Asia/Jakarta",
      ),
    );
    await ingest(photo(80));
    await run(media());
    expect(await db.pendingAction.count({ where: { consumedAt: null } })).toBe(
      1,
    );
    await ingest(update(81, "ya"));
    await run(media());
    // The newer receipt was confirmed; the older void request was superseded.
    expect(
      (await db.transaction.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("active");
    expect(await db.transaction.count()).toBe(2);
  });
});
describe("buttons, debts, bills and insights", () => {
  const zone = "Asia/Jakarta";
  const tap = (data: string, from = ownerChat, id = `cb${updateId}`) => ({
    update_id: updateId++,
    callback_query: {
      id,
      from: { id: from, is_bot: false },
      data,
      message: { message_id: 500, chat: { id: from, type: "private" } },
    },
  });
  const photo = (messageId: number, caption?: string) => ({
    update_id: updateId++,
    message: {
      message_id: messageId,
      date: now.getTime() / 1000,
      chat: { id: ownerChat, type: "private" },
      from: { id: ownerChat, is_bot: false },
      photo: [{ file_id: "p", file_size: 1000, width: 800, height: 600 }],
      ...(caption ? { caption } : {}),
    },
  });
  const receipt = {
    is_receipt: true,
    type: "expense" as const,
    merchant: "Warung Bu Sri",
    date: null,
    currency: "IDR",
    items: [
      { name: "Nasi goreng", quantity: 1, amount: "25000" },
      { name: "Mie ayam", quantity: 1, amount: "20000" },
      { name: "Es teh", quantity: 2, amount: "10000" },
    ],
    subtotal: "55000",
    tax: "5500",
    service: null,
    discount: null,
    total: "60500",
    payment_method: "QRIS",
    category: "food",
    problem: null,
  };
  const media = (plan?: ReceiptDeps["plan"]): ReceiptDeps => ({
    download: vi.fn(async () => Buffer.from("image")),
    read: vi.fn(async () => receipt),
    plan: plan ?? planSplit,
  });
  const run = (at = now, deps = media()) =>
    processInbox(db, at, zone, parse, 10, deps);
  const jobs = async () =>
    (await db.job.findMany({ orderBy: { createdAt: "asc" } })).map(
      (j) =>
        j.payload as {
          text: string;
          buttons?: { text: string; data: string }[][];
        },
    );
  const act = (input: Intent, at = now, confirmed = false) =>
    db.$transaction((tx) =>
      executeIntent(tx, owner, input, "m", at, zone, confirmed),
    );
  const wib = (iso: string) => new Date(`${iso}+07:00`);

  it("offers one-tap buttons and confirms through a stored button tap", async () => {
    await ingest(photo(90));
    await run();
    const [reply] = await jobs();
    const pending = await db.pendingAction.findFirstOrThrow();
    expect(reply.buttons).toEqual([
      [
        { text: "✅ Ya, simpan", data: `ok:${pending.id}` },
        { text: "❌ Batal", data: `no:${pending.id}` },
      ],
    ]);
    // A redelivered tap is stored once; strangers and unknown data are ignored.
    const ok = tap(`ok:${pending.id}`, ownerChat, "same-callback");
    expect((await ingest(ok, ok)).accepted).toBe(1);
    expect(
      (await ingest(tap(`ok:${pending.id}`, 2002), tap("drop:table"))).accepted,
    ).toBe(0);
    await run();
    expect((await db.transaction.findFirstOrThrow()).amount).toBe(60500n);
    expect((await jobs())[1].buttons).toBeUndefined();
  });
  it("cancels exactly the tapped proposal", async () => {
    await ingest(photo(91));
    await run();
    const pending = await db.pendingAction.findFirstOrThrow();
    await ingest(tap(`no:${pending.id}`));
    await run();
    expect(await db.transaction.count()).toBe(0);
    expect((await jobs())[1].text).toContain("nggak jadi");
    await ingest(tap(`ok:${pending.id}`));
    await run();
    expect(await db.transaction.count()).toBe(0);
  });
  it("records split-bill debts atomically with the user's share", async () => {
    const plan = vi.fn(async () => ({
      participants: ["aku", "Budi", "Sari"],
      assignments: [
        { item: 1, people: ["aku"] },
        { item: 2, people: ["Budi"] },
      ],
      payer: null,
      question: null,
    }));
    await ingest(photo(92, "split bill"));
    await run(now, media(plan));
    expect((await jobs())[0].text).toContain("piutang: Budi");
    expect(await db.debt.count()).toBe(0);
    await ingest(update(93, "ya"));
    await run(now, media(plan));
    const debts = await db.debt.findMany({ orderBy: { person: "asc" } });
    expect(debts.map((d) => [d.person, d.direction, d.amount])).toEqual([
      ["Budi", "owed_to_me", 25667n],
      ["Sari", "owed_to_me", 3666n],
    ]);
    const mine = await db.transaction.findFirstOrThrow();
    // The three shares still add up to the receipt total.
    expect(mine.amount + 25667n + 3666n).toBe(60500n);
    expect((await jobs())[1].text).toContain("Piutang dicatat");
  });
  it("records what the user owes when a friend paid", async () => {
    const plan = vi.fn(async () => ({
      participants: ["aku", "Budi"],
      assignments: [],
      payer: "Budi",
      question: null,
    }));
    await ingest(photo(94, "patungan, Budi yang bayar"));
    await run(now, media(plan));
    await ingest(update(95, "ya"));
    await run(now, media(plan));
    expect(await db.debt.findFirstOrThrow()).toMatchObject({
      person: "Budi",
      direction: "i_owe",
      amount: 30250n,
    });
  });
  it("tracks, settles and nudges debts once per step", async () => {
    await act(
      intent("create_debt", {
        person: "Budi",
        direction: "owed_to_me",
        amount: "50000",
        title: "tiket konser",
      }),
    );
    await act(
      intent("create_debt", {
        person: "budi",
        direction: "owed_to_me",
        amount: "30000",
        title: "bensin",
      }),
      new Date(now.getTime() + 60000),
    );
    expect(await act(intent("list_debts"))).toContain("Rp80.000");
    // Nothing is due yet; after three days one nudge with a settle button.
    await debtNudges(db, now, zone);
    expect(await db.job.count()).toBe(0);
    const later = new Date(now.getTime() + 3 * 86400000 + 120000);
    await debtNudges(db, later, zone);
    await debtNudges(db, later, zone);
    const nudges = await jobs();
    expect(nudges).toHaveLength(2);
    expect(nudges.every((n) => n.text.includes("Hai Budi"))).toBe(true);
    expect(nudges[0].buttons?.[0][0].data).toMatch(/^settle:/);
    // A partial payment needs confirmation and is applied oldest first.
    const reply = await act(
      intent("settle_debt", { person: "BUDI", amount: "60000" }),
    );
    expect(reply).toContain("Kode konfirmasi");
    const pending = await db.pendingAction.findFirstOrThrow();
    const done = await db.$transaction((tx) =>
      confirmAction(tx, owner, pending.id, "m2", now, zone),
    );
    expect(done).toContain("Sisa utangnya Rp20.000");
    const rows = await db.debt.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.status, r.paid])).toEqual([
      ["settled", 50000n],
      ["open", 10000n],
    ]);
    await expect(
      act(
        intent("settle_debt", { person: "Budi", amount: "99000" }),
        now,
        true,
      ),
    ).rejects.toThrow("Sisa utangnya cuma Rp20.000");
    // The nudge button settles that debt directly.
    await ingest(tap(`settle:${rows[1].id}`));
    await run();
    expect(
      (await db.debt.findUniqueOrThrow({ where: { id: rows[1].id } })).status,
    ).toBe("settled");
    expect(await db.auditLog.count({ where: { action: "debt.settle" } })).toBe(
      3,
    );
    // Settling is not income.
    expect(await db.transaction.count()).toBe(0);
  });
  it("asks which way when both people owe each other", async () => {
    for (const direction of ["owed_to_me", "i_owe"] as const)
      await act(
        intent("create_debt", {
          person: "Sari",
          direction,
          amount: "10000",
          title: "kopi",
        }),
      );
    await expect(
      act(intent("settle_debt", { person: "Sari" }), now, true),
    ).rejects.toThrow("sama-sama punya utang");
    expect(
      await act(
        intent("settle_debt", { person: "Sari", direction: "i_owe" }),
        now,
        true,
      ),
    ).toContain("Lunas");
  });
  it("reminds bills before, on and after the due day and records payment", async () => {
    const saved = await act(
      intent("create_bill", { title: "Internet", amount: "350000", day: 5 }),
    );
    expect(saved).toContain("tiap tanggal 5");
    const bill = await db.bill.findFirstOrThrow();
    expect(bill.nextDueAt).toEqual(wib("2026-11-05T09:00:00"));
    // Before 09:00 local time nothing is sent; three days before, once.
    await billReminders(db, wib("2026-11-02T08:00:00"), zone);
    expect(await db.job.count()).toBe(0);
    await billReminders(db, wib("2026-11-02T10:00:00"), zone);
    await billReminders(db, wib("2026-11-02T11:00:00"), zone);
    await billReminders(db, wib("2026-11-05T09:30:00"), zone);
    const sent = await jobs();
    expect(sent.map((j) => j.text.split(" ")[0])).toEqual(["🔔", "📅"]);
    expect(sent[0].buttons?.[0][0].data).toBe(`paid:${bill.id}`);
    // Tapping "Udah bayar" records the expense and moves to next month.
    await ingest(tap(`paid:${bill.id}`));
    await run(wib("2026-11-05T10:00:00"));
    expect(await db.transaction.findFirstOrThrow()).toMatchObject({
      amount: 350000n,
      category: "bills",
      description: "Tagihan Internet",
    });
    expect((await db.bill.findFirstOrThrow()).nextDueAt).toEqual(
      wib("2026-12-05T09:00:00"),
    );
    // A second tap does not record twice.
    await ingest(tap(`paid:${bill.id}`));
    await run(wib("2026-11-05T10:05:00"));
    expect(await db.transaction.count()).toBe(1);
    expect((await jobs()).at(-1)?.text).toContain("sudah tercatat lunas");
  });
  it("asks the amount of variable bills and clamps day 31", async () => {
    await act(intent("create_bill", { title: "Listrik", day: 31 }));
    const bill = await db.bill.findFirstOrThrow();
    expect(bill.nextDueAt).toEqual(wib("2026-10-31T09:00:00"));
    expect(
      await act(
        intent("pay_bill", { title: "listrik" }),
        wib("2026-10-31T10:00:00"),
      ),
    ).toContain("Berapa tagihan Listrik");
    expect(await db.transaction.count()).toBe(0);
    await act(
      intent("pay_bill", { title: "listrik", amount: "450000" }),
      wib("2026-10-31T10:00:00"),
    );
    expect((await db.bill.findFirstOrThrow()).nextDueAt).toEqual(
      wib("2026-11-30T09:00:00"),
    );
    expect(await act(intent("list_bills"))).toContain("Listrik");
    expect(await act(intent("cancel_bill", { title: "Listrik" }))).toContain(
      "Kode konfirmasi",
    );
  });
  it("explains budget pace, spending spikes, bills and debts from data", async () => {
    await db.$transaction(async (tx) => {
      await saveBudget(
        tx,
        owner,
        { month: "2026-10", category: "food", amount: "1000000" },
        now,
      );
      const spend = (amount: string, category: string, at: string) =>
        saveTransaction(
          tx,
          owner,
          {
            ...transaction(amount),
            category,
            occurredAt: wib(at).toISOString(),
          },
          { now },
        );
      await spend("700000", "food", "2026-10-11T12:00:00");
      for (const day of ["09-15", "09-22", "09-29", "10-03"])
        await spend("50000", "entertainment", `2026-${day}T20:00:00`);
      await spend("200000", "entertainment", "2026-10-10T20:00:00");
    });
    await act(
      intent("create_bill", { title: "Internet", amount: "350000", day: 15 }),
    );
    await act(
      intent("create_debt", {
        person: "Budi",
        direction: "owed_to_me",
        amount: "27500",
        title: "sate",
      }),
      new Date(now.getTime() - 8 * 86400000),
    );
    const text = await act(intent("finance_insight"));
    expect(text).toContain("🟡 Anggaran Makan & Minum sudah terpakai 70%");
    expect(text).toContain("Rp15.000 per hari");
    expect(text).toContain(
      "📈 Pengeluaran Hiburan 7 hari terakhir Rp200.000, 4,0×",
    );
    expect(text).toContain("Internet (15 Okt, Rp350.000)");
    expect(text).toContain("Budi, 8 hari");
    const morning = await db.$transaction((tx) =>
      report(tx, owner, "daily", now, zone),
    );
    expect(morning).toContain("Insight keuangan:");
    expect(morning).not.toContain("🟢");
  });
});
describe("voice notes, savings goals, habits and meaning search", () => {
  const zone = "Asia/Jakarta";
  const wib = (iso: string) => new Date(`${iso}+07:00`);
  const voiceUpdate = (messageId: number, duration = 4) => ({
    update_id: updateId++,
    message: {
      message_id: messageId,
      date: now.getTime() / 1000,
      chat: { id: ownerChat, type: "private" },
      from: { id: ownerChat, is_bot: false },
      voice: {
        file_id: "voice-file",
        duration,
        mime_type: "audio/ogg",
        file_size: 9000,
      },
    },
  });
  const tap = (data: string) => ({
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: ownerChat, is_bot: false },
      data,
      message: { message_id: 700, chat: { id: ownerChat, type: "private" } },
    },
  });
  const voice = (transcript: string | Error): VoiceDeps => ({
    download: vi.fn(async () => Buffer.from("ogg")),
    transcribe: vi.fn(async () => {
      if (transcript instanceof Error) throw transcript;
      return transcript;
    }),
  });
  const media: ReceiptDeps = {
    download: vi.fn(),
    read: vi.fn(),
    plan: planSplit,
  };
  const run = (deps: VoiceDeps, at = now) =>
    processInbox(db, at, zone, parse, 10, media, deps);
  const texts = async () =>
    (await db.job.findMany({ orderBy: { createdAt: "asc" } })).map(
      (j) =>
        j.payload as {
          text: string;
          buttons?: { text: string; data: string }[][];
        },
    );
  const act = (input: Intent, at = now, confirmed = false) =>
    db.$transaction((tx) =>
      executeIntent(tx, owner, input, "m", at, zone, confirmed),
    );
  afterEach(() => vi.unstubAllEnvs());

  it("transcribes a voice note and acts on the words, keeping only the text", async () => {
    await ingest(voiceUpdate(100), voiceUpdate(101, 400));
    const stored = await db.inboxMessage.findMany({ orderBy: { id: "asc" } });
    expect(stored[0]).toMatchObject({ fileMime: "audio/ogg", text: "" });
    expect(stored[1].text).toBe("[AUDIO_TOO_LONG]");
    const deps = voice("Pengeluaran 50000 makan siang");
    await run(deps);
    expect(deps.download).toHaveBeenCalledWith("voice-file");
    expect((await db.transaction.findFirstOrThrow()).amount).toBe(50000n);
    const [first, second] = await texts();
    expect(first.text).toMatch(/^🎙️ “Pengeluaran 50000 makan siang”\n\n✅/);
    expect(second.text).toContain("kepanjangan");
    expect(
      (await db.inboxMessage.findUniqueOrThrow({ where: { id: stored[0].id } }))
        .text,
    ).toBe("Pengeluaran 50000 makan siang");
  });
  it("lets a spoken “iya” answer a pending question and reports failures", async () => {
    await act(
      intent("create_bill", { title: "Internet", amount: "350000", day: 20 }),
    );
    await act(intent("cancel_bill", { title: "Internet" }));
    await ingest(voiceUpdate(102));
    await run(voice("Iya."));
    expect((await db.bill.findFirstOrThrow()).status).toBe("cancelled");
    await ingest(voiceUpdate(103));
    await run(
      voice(new AppError("TRANSCRIBE_UNAVAILABLE", 503, "gagal mendengarkan")),
    );
    expect((await texts()).at(-1)?.text).toContain("gagal mendengarkan");
    await ingest(voiceUpdate(104));
    await run(voice(""));
    expect((await texts()).at(-1)?.text).toContain("nggak menangkap ucapan");
  });
  it("tracks savings goals without touching income or expense", async () => {
    const created = await act(
      intent("create_goal", {
        title: "Laptop",
        amount: "5000000",
        date: "2026-12-31T00:00:00+07:00",
      }),
    );
    expect(created).toContain("Rp416.667 per minggu");
    const deposit = await act(
      intent("add_saving", { title: "laptop", amount: "1000000" }),
    );
    expect(deposit).toContain("Rp1.000.000 / Rp5.000.000 (20%)");
    expect(deposit).toContain("▓▓░░░░░░░░");
    await expect(
      act(intent("withdraw_saving", { title: "Laptop", amount: "2000000" })),
    ).rejects.toThrow("nggak bisa diambil");
    // With a single goal the name may be omitted.
    expect(await act(intent("add_saving", { amount: "4000000" }))).toContain(
      "tercapai",
    );
    expect((await db.goal.findFirstOrThrow()).achievedAt).toEqual(now);
    await act(intent("create_goal", { title: "Liburan", amount: "3000000" }));
    await expect(act(intent("add_saving", { amount: "1000" }))).rejects.toThrow(
      "Buat target yang mana",
    );
    expect(await db.transaction.count()).toBe(0);
    expect(await act(intent("list_goals"))).toContain("Liburan");
  });
  it("flags a goal that trails its deadline in insights", async () => {
    const start = new Date(now.getTime() - 30 * 86400000);
    await act(
      intent("create_goal", {
        title: "Motor",
        amount: "3000000",
        date: new Date(start.getTime() + 60 * 86400000).toISOString(),
      }),
      start,
    );
    expect(await act(intent("finance_insight"))).toContain(
      "🎯 Target Motor agak ketinggalan",
    );
  });
  it("checks in on habits once a day after their time and counts streaks", async () => {
    await act(
      intent("create_habit", {
        title: "Olahraga",
        date: "2026-10-12T19:00:00+07:00",
      }),
    );
    const habit = await db.habit.findFirstOrThrow();
    expect(habit.checkinTime).toBe("19:00");
    await habitCheckins(db, wib("2026-10-12T18:59:00"), zone);
    expect(await db.job.count()).toBe(0);
    await habitCheckins(db, wib("2026-10-12T19:00:00"), zone);
    await habitCheckins(db, wib("2026-10-12T21:00:00"), zone);
    const [checkin] = await texts();
    expect(await db.job.count()).toBe(1);
    expect(checkin.buttons?.[0].map((b) => b.data)).toEqual([
      `done:${habit.id}`,
      `skip:${habit.id}`,
    ]);
    await ingest(tap(`done:${habit.id}`));
    await run(voice(""), wib("2026-10-12T21:05:00"));
    expect((await texts()).at(-1)?.text).toContain(
      "Olahraga hari ini tercatat",
    );
    // The next day, a typed report extends the streak and stops the check-in.
    expect(
      await act(
        intent("log_habit", { title: "olahraga" }),
        wib("2026-10-13T07:00:00"),
      ),
    ).toContain("Streak 2 hari");
    await habitCheckins(db, wib("2026-10-13T20:00:00"), zone);
    expect(await db.job.count()).toBe(2);
    // Skipping is recorded, and the latest answer for a day wins.
    await act(
      intent("log_habit", { title: "Olahraga", status: "cancelled" }),
      wib("2026-10-14T20:00:00"),
    );
    expect(
      await act(intent("list_habits"), wib("2026-10-14T21:00:00")),
    ).toContain("⏭️ Olahraga — 7 hari terakhir 2/7");
    expect(
      await db.$transaction((tx) =>
        report(tx, owner, "weekly", wib("2026-10-14T21:00:00"), zone),
      ),
    ).toContain("• Olahraga: 2/7 hari");
  });
  it("embeds pending notes once and finds notes by meaning", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-only");
    vi.stubEnv("GEMINI_EMBEDDING_MODEL", "embedding-test");
    // A unit vector whose similarity with the query [1, 0, ...] equals score.
    const vector = (score: number) => [
      score,
      Math.sqrt(1 - score * score),
      ...Array<number>(254).fill(0),
    ];
    const scores: Record<string, number> = {
      "SaaS klinik hewan": 0.9,
      "Grooming kucing": 0.88,
      "Resep rendang": 0.7,
      Arsip: 0.95,
    };
    const embedder = vi.fn(async (texts: string[], kind: string) =>
      kind === "query"
        ? [vector(1)]
        : texts.map((t) => vector(scores[t.split("\n")[0]] ?? 0)),
    );
    await db.$transaction(async (tx) => {
      for (const title of Object.keys(scores))
        await saveNote(tx, owner, {
          title,
          content: title,
          archived: title === "Arsip",
        });
      await tx.note.create({
        data: { ownerId: "another-owner", title: "Kucing", content: "x" },
      });
    });
    expect((await embedPendingNotes(db, 20, embedder)).embedded).toBe(4);
    expect((await embedPendingNotes(db, 20, embedder)).embedded).toBe(0);
    const found = await db.$transaction((tx) =>
      similarNotes(tx, owner, "ide soal hewan peliharaan", 5, embedder),
    );
    // Above the minimum and close to the best; archived and other owners excluded.
    expect(found.map((n) => n.title)).toEqual([
      "SaaS klinik hewan",
      "Grooming kucing",
    ]);
    // Editing a note clears its vector so the backfill embeds the new text.
    const note = await db.note.findFirstOrThrow({
      where: { title: "Resep rendang" },
    });
    await db.$transaction((tx) =>
      saveNote(tx, owner, { title: "Resep rendang", content: "baru" }, note.id),
    );
    expect(
      (await db.note.findUniqueOrThrow({ where: { id: note.id } }))
        .embeddingModel,
    ).toBeNull();
    expect((await embedPendingNotes(db, 20, embedder)).embedded).toBe(1);
    // A provider failure stores nothing and is reported.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await db.$transaction((tx) =>
      saveNote(tx, owner, { title: "Baru", content: "baru" }),
    );
    expect(
      await embedPendingNotes(db, 20, async () => {
        throw Object.assign(new Error("429"), { status: 429 });
      }),
    ).toMatchObject({ embedded: 0, failed: true });
    vi.restoreAllMocks();
  });
});
