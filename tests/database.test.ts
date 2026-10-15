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
import { saveTask, saveReminder } from "@/services/records";
import { ingestUpdates, pollUpdates } from "@/integrations/telegram";
import { processInbox } from "@/services/inbox";
import { fallback, intent, type Turn } from "@/services/ai";
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
import { automate } from "@/services/automation";
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
    'TRUNCATE "AuditLog", "BudgetAlert", "Budget", "SheetSyncOutbox", "Transaction", "Account", "Reminder", "Task", "Note", "PendingAction", "Job", "InboxMessage", "Heartbeat" RESTART IDENTITY CASCADE',
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
