import { z } from "zod";
export const money = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, "Gunakan rupiah bulat positif.")
  .refine(
    (v) => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n,
    "Nominal terlalu besar.",
  );
const title = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(2000).nullable().optional();
export const isoDate = z.iso.datetime({ offset: true });
export const transactionInput = z
  .object({
    type: z.enum(["income", "expense", "transfer"]),
    amount: money,
    occurredAt: isoDate,
    category: z.string().trim().min(1).max(80),
    description: title,
    paymentMethod: z.string().max(80).nullable().optional(),
    accountId: z.string().uuid().nullable().optional(),
    toAccountId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.type !== "transfer" ||
      (v.accountId && v.toAccountId && v.accountId !== v.toAccountId),
    { message: "Transfer memerlukan dua akun berbeda.", path: ["toAccountId"] },
  );
export const taskInput = z
  .object({
    title,
    description: optionalText,
    status: z
      .enum(["open", "in_progress", "completed", "cancelled"])
      .default("open"),
    priority: z.number().int().min(1).max(3).default(2),
    dueAt: isoDate.nullable().optional(),
    project: z.string().max(100).nullable().optional(),
  })
  .strict();
export const noteInput = z
  .object({
    title,
    content: z.string().trim().min(1).max(20000),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    category: z.string().min(1).max(80).default("general"),
    project: z.string().max(100).nullable().optional(),
    archived: z.boolean().default(false),
  })
  .strict();
export const reminderInput = z
  .object({
    title,
    message: optionalText,
    scheduledAt: isoDate,
    timezone: z.string().default("Asia/Jakarta"),
    recurrence: z.enum(["once", "daily", "weekly", "monthly"]).default("once"),
    taskId: z.string().uuid().nullable().optional(),
    status: z.enum(["active", "cancelled"]).default("active"),
  })
  .strict();
export const budgetInput = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    category: z.string().trim().min(1).max(80),
    amount: money,
    warningPercent: z.number().int().min(1).max(100).default(80),
  })
  .strict();
export const filters = z
  .object({
    q: z.string().max(200).optional(),
    kind: z.enum(["daily", "weekly", "recap"]).optional(),
    type: z.enum(["income", "expense", "transfer"]).optional(),
    category: z.string().max(80).optional(),
    accountId: z.string().uuid().optional(),
    status: z
      .enum([
        "open",
        "in_progress",
        "completed",
        "cancelled",
        "overdue",
        "active",
        "archived",
        "all",
      ])
      .optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    tag: z.string().max(50).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
  })
  .strict();
export const confirmation = z.object({
  confirmed: z.literal(true),
  expectedUpdatedAt: isoDate.optional(),
});
