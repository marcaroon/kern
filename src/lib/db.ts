import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { required } from "./config";
const globalDb = globalThis as unknown as { kernDb?: PrismaClient };
// Hosted runtimes cannot read a local sslrootcert file, so DATABASE_CA_CERT may carry
// the PEM instead. Certificate and hostname verification stay enabled either way.
export function connectionOptions() {
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  if (!ca) return { connectionString: required("DATABASE_URL") };
  const url = new URL(required("DATABASE_URL"));
  // URL SSL parameters would override the explicit ssl option in node-postgres.
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
    url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    ssl: { ca, rejectUnauthorized: true },
  };
}
export function db() {
  if (!globalDb.kernDb)
    globalDb.kernDb = new PrismaClient({
      adapter: new PrismaPg({
        ...connectionOptions(),
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
