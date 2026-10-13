import { z } from "zod";
import { DateTime } from "luxon";
const schema = z.object({
  TIME_ZONE: z
    .string()
    .default("Asia/Jakarta")
    .refine((v) => DateTime.now().setZone(v).isValid, "Invalid timezone"),
  KERN_OWNER_SUPABASE_USER_ID: z.string().uuid().optional(),
  KERN_INTERNAL_API_SECRET: z.string().min(32).optional(),
  KERN_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});
export function config() {
  return schema.parse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")),
  );
}
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CONFIG_MISSING:${name}`);
  return value;
}
export function ownerId() {
  return (
    config().KERN_OWNER_SUPABASE_USER_ID ||
    required("KERN_OWNER_SUPABASE_USER_ID")
  );
}
export function configured(...names: string[]) {
  return names.every((name) => Boolean(process.env[name]));
}
// Numeric Telegram user IDs; the first one receives reports and reminders.
export function allowedTelegramIds() {
  return (process.env.TELEGRAM_OWNER_USER_ID || "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d{1,20}$/.test(v));
}
