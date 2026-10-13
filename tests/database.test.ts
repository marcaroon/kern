import {
  beforeAll,
  afterAll,
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
import { fallback, intent } from "@/services/ai";
import { executeIntent, confirmAction } from "@/services/conversation";
import { materializeReminders } from "@/services/reminders";
import { dispatchMessages, DeliveryError, enqueue } from "@/services/queue";
import { syncSheets } from "@/services/sheets";
import { sheetHeaders, type SheetPort } from "@/integrations/sheets";
vi.mock("@/lib/auth", () => ({
  requireOwner: async () => "11111111-1111-4111-8111-111111111111",
}));
import { handleApi } from "@/controllers/api";

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
    'TRUNCATE "AuditLog", "BudgetAlert", "Budget", "SheetSyncOutbox", "Transaction", "Account", "Reminder", "Task", "Note", "PendingAction", "Job", "InboxMessage" RESTART IDENTITY CASCADE',
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
    ).toContain("sudah digunakan");
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
});
