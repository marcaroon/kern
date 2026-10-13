import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { required } from "./config";
const globalDb = globalThis as unknown as { kernDb?: PrismaClient };
export function db() {
  if (!globalDb.kernDb)
    globalDb.kernDb = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: required("DATABASE_URL"),
        connectionTimeoutMillis: 5000,
        max: 5,
      }),
    });
  return globalDb.kernDb;
}
export type Tx = Prisma.TransactionClient;
export type Database = PrismaClient;
export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
export async function audit(
  tx: Tx,
  ownerId: string,
  action: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
) {
  await tx.auditLog.create({
    data: {
      ownerId,
      action,
      entityId,
      ...(before ? { before: json(before) } : {}),
      ...(after ? { after: json(after) } : {}),
    },
  });
}
