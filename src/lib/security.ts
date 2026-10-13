import { timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";
export function constantEqual(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function assertOwner(
  actual: string | undefined,
  expected: string | undefined,
) {
  if (!actual) throw new AppError("UNAUTHENTICATED", 401, "Silakan masuk.");
  if (!expected || actual !== expected)
    throw new AppError("FORBIDDEN", 403, "Akun ini bukan pemilik KERN.");
  return actual;
}
export function assertInternal(
  header: string | null,
  secret: string | undefined,
) {
  if (!secret || secret.length < 32)
    throw new AppError("INTERNAL_NOT_CONFIGURED", 503);
  if (!header || !constantEqual(header, `Bearer ${secret}`))
    throw new AppError("UNAUTHORIZED", 401);
}
export function assertOrigin(request: Request) {
  const expected = new URL(
    process.env.NEXT_PUBLIC_APP_URL ||
      // Vercel provides the production domain, so hosted copies need no extra setting.
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "http://localhost:3000"),
  ).origin;
  if (request.headers.get("origin") !== expected)
    throw new AppError("INVALID_ORIGIN", 403);
}
export async function readBody(request: Request, max = 65536) {
  if (Number(request.headers.get("content-length") || 0) > max)
    throw new AppError("PAYLOAD_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new AppError("PAYLOAD_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function bodyJson(request: Request) {
  try {
    return JSON.parse(await readBody(request));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("INVALID_JSON", 400);
  }
}
// Single-owner process guard; deploy an upstream shared rate limit for multiple replicas.
const buckets = new Map<string, { count: number; until: number }>();
export function rateLimit(key: string, limit: number, now = Date.now()) {
  if (buckets.size > 2000)
    for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
  const bucket = buckets.get(key);
  if (!bucket || bucket.until <= now) {
    buckets.set(key, { count: 1, until: now + 60000 });
    return;
  }
  if (++bucket.count > limit)
    throw new AppError(
      "RATE_LIMITED",
      429,
      "Terlalu banyak permintaan. Coba lagi sebentar.",
    );
}
