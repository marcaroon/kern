import { z } from "zod";
import { db, audit } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { assertOrigin, bodyJson, rateLimit } from "@/lib/security";
import { boundary, respond, AppError } from "@/lib/errors";
import { config } from "@/lib/config";
import { filters, confirmation } from "@/lib/validation";
import {
  saveTransaction,
  voidTransaction,
  saveBudget,
  financeSummary,
  budgetStatus,
} from "@/services/finance";
import { saveTask, saveNote, saveReminder } from "@/services/records";
import { dashboard, report } from "@/services/reporting";
import { integrationHealth } from "@/services/health";

const resources = z.enum([
  "transactions",
  "tasks",
  "reminders",
  "notes",
  "budgets",
  "accounts",
  "dashboard",
  "finance",
  "reports",
  "health",
  "jobs",
  "sync",
  "inbox",
]);
type Context = { params: Promise<{ resource: string; id?: string[] }> };
export function handleApi(request: Request, context: Context) {
  return boundary(async () => {
    const ownerId = await requireOwner();
    rateLimit(`owner:${ownerId}`, 120);
    const params = await context.params;
    const resource = resources.parse(params.resource);
    if ((params.id?.length || 0) > 1) throw new AppError("NOT_FOUND", 404);
    const id = params.id?.[0];
    if (id && resource !== "inbox") z.string().uuid().parse(id);
    const database = db(),
      now = new Date(),
      zone = config().TIME_ZONE;
    if (request.method === "GET") {
      const q = filters.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (resource === "dashboard")
        return respond(await dashboard(database, ownerId, now, zone));
      if (resource === "health")
        return respond(await integrationHealth(database, ownerId));
      if (resource === "finance")
        return respond({
          today: await financeSummary(database, ownerId, "today", now, zone),
          month: await financeSummary(database, ownerId, "month", now, zone),
          previousMonth: await financeSummary(
            database,
            ownerId,
            "previous_month",
            now,
            zone,
          ),
          budgets: await budgetStatus(database, ownerId, now, zone),
        });
      if (resource === "reports")
        return respond({
          text: await report(database, ownerId, q.kind || "weekly", now, zone),
        });
      const base = { ownerId, ...(id ? { id } : {}) },
        paging = { take: 50, skip: (q.page - 1) * 50 };
      switch (resource) {
        case "transactions": {
          const where = {
            ...base,
            ...(q.type ? { type: q.type } : {}),
            ...(q.category ? { category: q.category } : {}),
            ...(q.accountId
              ? {
                  OR: [
                    { accountId: q.accountId },
                    { toAccountId: q.accountId },
                  ],
                }
              : {}),
            ...(q.q
              ? { description: { contains: q.q, mode: "insensitive" as const } }
              : {}),
            ...(q.from || q.to
              ? { occurredAt: { gte: q.from, lt: q.to } }
              : {}),
          };
          return respond({
            rows: await database.transaction.findMany({
              where,
              orderBy: { occurredAt: "desc" },
              include: { account: true, toAccount: true },
              ...paging,
            }),
            count: await database.transaction.count({ where }),
          });
        }
        case "tasks": {
          const where = {
            ...base,
            ...(q.q
              ? { title: { contains: q.q, mode: "insensitive" as const } }
              : {}),
            ...(q.status === "overdue"
              ? { status: { in: ["open", "in_progress"] }, dueAt: { lt: now } }
              : q.status && q.status !== "all"
                ? { status: q.status }
                : {}),
          };
          return respond({
            rows: await database.task.findMany({
              where,
              orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
              ...paging,
            }),
            count: await database.task.count({ where }),
          });
        }
        case "reminders": {
          const where = {
            ...base,
            ...(q.q
              ? { title: { contains: q.q, mode: "insensitive" as const } }
              : {}),
            ...(q.status && q.status !== "all" ? { status: q.status } : {}),
          };
          return respond({
            rows: await database.reminder.findMany({
              where,
              orderBy: { scheduledAt: "asc" },
              ...paging,
            }),
            count: await database.reminder.count({ where }),
          });
        }
        case "notes": {
          const where = {
            ...base,
            archived: q.status === "archived",
            ...(q.category ? { category: q.category } : {}),
            ...(q.tag ? { tags: { has: q.tag } } : {}),
            ...(q.q
              ? {
                  OR: [
                    { title: { contains: q.q, mode: "insensitive" as const } },
                    {
                      content: { contains: q.q, mode: "insensitive" as const },
                    },
                  ],
                }
              : {}),
          };
          return respond({
            rows: await database.note.findMany({
              where,
              orderBy: { updatedAt: "desc" },
              ...paging,
            }),
            count: await database.note.count({ where }),
          });
        }
        case "budgets":
          return respond({
            rows: await budgetStatus(database, ownerId, now, zone),
          });
        case "accounts":
          return respond({
            rows: await database.account.findMany({
              where: base,
              orderBy: { name: "asc" },
            }),
          });
        default:
          throw new AppError("METHOD_NOT_ALLOWED", 405);
      }
    }
    assertOrigin(request);
    const raw = z
      .record(z.string(), z.unknown())
      .parse(await bodyJson(request));
    if (request.method === "PATCH" && !id)
      throw new AppError("ID_REQUIRED", 422);
    if (request.method === "POST" && id)
      throw new AppError("METHOD_NOT_ALLOWED", 405);
    if (id || resource === "budgets") confirmation.parse(raw);
    const {
      confirmed: _confirmed,
      expectedUpdatedAt,
      action,
      acknowledgeDuplicateRisk,
      ...input
    } = raw;
    void _confirmed;
    if (
      action !== undefined &&
      (resource !== "transactions" || action !== "void" || !id)
    )
      throw new AppError("INVALID_ACTION", 422);
    const result = await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`owner:${ownerId}`}))`;
      if (
        id &&
        ["transactions", "tasks", "reminders", "notes"].includes(resource)
      ) {
        if (!expectedUpdatedAt)
          throw new AppError(
            "VERSION_REQUIRED",
            422,
            "Muat ulang catatan sebelum mengubahnya.",
          );
        const record =
          resource === "transactions"
            ? await tx.transaction.findFirst({ where: { id, ownerId } })
            : resource === "tasks"
              ? await tx.task.findFirst({ where: { id, ownerId } })
              : resource === "reminders"
                ? await tx.reminder.findFirst({ where: { id, ownerId } })
                : await tx.note.findFirst({ where: { id, ownerId } });
        if (!record) throw new AppError("NOT_FOUND", 404);
        if (record.updatedAt.toISOString() !== expectedUpdatedAt)
          throw new AppError(
            "STALE_RECORD",
            409,
            "Catatan sudah berubah. Muat ulang sebelum menyimpan.",
          );
      }
      switch (resource) {
        case "transactions":
          return action === "void" && id
            ? voidTransaction(tx, ownerId, id, now)
            : saveTransaction(tx, ownerId, input, { id, now, zone });
        case "tasks":
          return saveTask(tx, ownerId, input, id, now);
        case "notes":
          return saveNote(tx, ownerId, input, id);
        case "reminders":
          return saveReminder(tx, ownerId, input, id, now);
        case "budgets":
          return saveBudget(tx, ownerId, input, now, zone);
        case "accounts": {
          if (id) throw new AppError("METHOD_NOT_ALLOWED", 405);
          const parsed = z
            .object({ name: z.string().trim().min(1).max(80) })
            .strict()
            .parse(input);
          return tx.account.upsert({
            where: { ownerId_name: { ownerId, name: parsed.name } },
            update: {},
            create: { ownerId, name: parsed.name },
          });
        }
        case "jobs": {
          if (!id) throw new AppError("ID_REQUIRED", 422);
          const job = await tx.job.findFirst({
            where: {
              id,
              ownerId,
              status: { in: ["blocked", "failed", "uncertain"] },
            },
          });
          if (!job) throw new AppError("JOB_NOT_RETRYABLE", 409);
          if (job.status === "uncertain" && acknowledgeDuplicateRisk !== true)
            throw new AppError(
              "DUPLICATE_RISK_ACK_REQUIRED",
              422,
              "Periksa chat Telegram dahulu; pengiriman ulang berisiko duplikat.",
            );
          await audit(tx, ownerId, "job.manual_retry", id, job);
          return tx.job.update({
            where: { id },
            data: {
              status: "pending",
              attempts: 0,
              availableAt: now,
              lastError: null,
            },
          });
        }
        case "sync": {
          if (!id) throw new AppError("ID_REQUIRED", 422);
          const result = await tx.sheetSyncOutbox.updateMany({
            where: { id, ownerId, status: { in: ["failed", "retry"] } },
            data: {
              status: "pending",
              attempts: 0,
              availableAt: now,
              lastError: null,
            },
          });
          await audit(tx, ownerId, "sync.manual_retry", id);
          return result;
        }
        case "inbox": {
          if (!id) throw new AppError("ID_REQUIRED", 422);
          const result = await tx.inboxMessage.updateMany({
            where: { id, ownerId, status: "failed" },
            data: {
              status: "pending",
              attempts: 0,
              availableAt: now,
              lastError: null,
            },
          });
          await audit(tx, ownerId, "inbox.manual_retry", id);
          return result;
        }
        default:
          throw new AppError("METHOD_NOT_ALLOWED", 405);
      }
    });
    return respond(result, request.method === "POST" ? 201 : 200);
  });
}
