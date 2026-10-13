import { z } from "zod";
import type { Database } from "@/lib/db";
import { allowedTelegramIds, configured, required } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { DeliveryError, type Outbound } from "@/services/queue";
const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      from: z.object({ id: z.number().int(), is_bot: z.boolean() }).optional(),
      text: z.string().max(6000).optional(),
    })
    .optional(),
});
const envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
});
export type TelegramUpdate = z.infer<typeof updateSchema>;
export function telegramMode() {
  const mode = process.env.TELEGRAM_MODE;
  if (mode === "webhook" || mode === "polling") return mode;
  // Vercel has no resident worker to poll, so it defaults to webhook delivery.
  return process.env.VERCEL ? "webhook" : "polling";
}
// Setup mode: until an allowlist exists, tell each private sender their own numeric ID
// (and nothing else) so the owner can configure TELEGRAM_OWNER_USER_ID without tools.
export async function setupReplies(
  raw: unknown[],
  allowed: string[],
  transport: typeof fetch = fetch,
) {
  if (allowed.length || !configured("TELEGRAM_BOT_TOKEN")) return 0;
  let sent = 0;
  for (const item of raw) {
    const message = updateSchema.safeParse(item).data?.message;
    if (
      message?.chat.type !== "private" ||
      !message.from ||
      message.from.is_bot ||
      message.from.id !== message.chat.id
    )
      continue;
    await call(
      "sendMessage",
      {
        chat_id: message.chat.id,
        text: `KERN belum dikonfigurasi. ID Telegram kamu: ${message.from.id}\nIsi TELEGRAM_OWNER_USER_ID dengan angka ini, lalu deploy ulang.`,
      },
      transport,
      15000,
    ).catch(() => undefined);
    sent++;
  }
  return sent;
}
// Inbox IDs are stable per chat message, so a redelivered update never repeats an action.
export function inboxId(chatId: number, messageId: number) {
  return `tg:${chatId}:${messageId}`;
}
export async function ingestUpdates(
  database: Database,
  raw: unknown[],
  ownerId: string,
  allowed: string[],
  now = new Date(),
) {
  let accepted = 0;
  for (const item of raw) {
    const parsed = updateSchema.safeParse(item);
    if (!parsed.success || !parsed.data.message) continue;
    const message = parsed.data.message;
    // Private chats with an allowlisted human only; groups and bots never reach the inbox.
    if (
      message.chat.type !== "private" ||
      !message.from ||
      message.from.is_bot ||
      message.from.id !== message.chat.id ||
      !allowed.includes(String(message.from.id))
    )
      continue;
    const receivedAt = new Date(Math.min(message.date * 1000, now.getTime()));
    const result = await database.inboxMessage.createMany({
      data: {
        id: inboxId(message.chat.id, message.message_id),
        ownerId,
        sender: String(message.chat.id),
        receivedAt,
        availableAt: now,
        text: message.text !== undefined ? message.text : "[UNSUPPORTED_MEDIA]",
      },
      skipDuplicates: true,
    });
    accepted += result.count;
  }
  return { accepted };
}
async function call(
  method: string,
  body: unknown,
  transport: typeof fetch,
  timeoutMs: number,
) {
  // The token is part of the URL; never include the URL or provider text in errors.
  return transport(
    `https://api.telegram.org/bot${required("TELEGRAM_BOT_TOKEN")}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
}
export async function pollUpdates(
  database: Database,
  ownerId: string,
  transport: typeof fetch = fetch,
  now = new Date(),
) {
  if (!configured("TELEGRAM_BOT_TOKEN"))
    throw new AppError("TELEGRAM_NOT_CONFIGURED", 503);
  const read = async (body: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await call("getUpdates", body, transport, 15000);
    } catch {
      throw new AppError("TELEGRAM_UNAVAILABLE", 503);
    }
    const parsed = envelope.safeParse(await response.json().catch(() => null));
    if (response.status === 409)
      throw new AppError("TELEGRAM_WEBHOOK_ACTIVE", 409);
    if (response.status === 401 || response.status === 404)
      throw new AppError("TELEGRAM_UNAUTHORIZED", 503);
    if (!response.ok || !parsed.success || !parsed.data.ok)
      throw new AppError("TELEGRAM_UNAVAILABLE", 503);
    return z.array(z.unknown()).parse(parsed.data.result ?? []);
  };
  const updates = await read({
    limit: 100,
    timeout: 0,
    allowed_updates: ["message"],
  });
  if (!updates.length) return { received: 0, accepted: 0 };
  const { accepted } = await ingestUpdates(
    database,
    updates,
    ownerId,
    allowedTelegramIds(),
    now,
  );
  await setupReplies(updates, allowedTelegramIds(), transport);
  // Confirm only after the inbox commit; a crash before this point redelivers safely.
  const last = Math.max(
    ...updates.map(
      (u) => z.object({ update_id: z.number() }).parse(u).update_id,
    ),
  );
  await read({ offset: last + 1, limit: 1, timeout: 0 });
  return { received: updates.length, accepted };
}
export function telegramSender(transport: typeof fetch = fetch) {
  return async (payload: Outbound) => {
    if (!configured("TELEGRAM_BOT_TOKEN"))
      throw new DeliveryError("TELEGRAM_NOT_CONFIGURED", "blocked");
    const allowed = allowedTelegramIds();
    const chatId = payload.chatId || allowed[0];
    if (!chatId || !allowed.includes(chatId))
      throw new DeliveryError("TELEGRAM_OWNER_NOT_CONFIGURED", "blocked");
    let response: Response;
    try {
      response = await call(
        "sendMessage",
        {
          chat_id: chatId,
          text: payload.text.slice(0, 4096),
          link_preview_options: { is_disabled: true },
        },
        transport,
        15000,
      );
    } catch {
      throw new DeliveryError("TELEGRAM_SEND_UNCERTAIN", "uncertain");
    }
    if (!response.ok) {
      if (response.status === 429)
        throw new DeliveryError("TELEGRAM_RATE_LIMIT", "retry");
      if (response.status >= 500)
        throw new DeliveryError("TELEGRAM_SERVER_UNCERTAIN", "uncertain");
      // 401/404: invalid token; 403: the owner blocked or never started the bot; 400: unknown chat.
      if ([400, 401, 403, 404].includes(response.status))
        throw new DeliveryError(`TELEGRAM_${response.status}`, "blocked");
      throw new DeliveryError(`TELEGRAM_${response.status}`, "failed");
    }
    const result = z
      .object({
        ok: z.literal(true),
        result: z.object({ message_id: z.number().int() }),
      })
      .safeParse(await response.json().catch(() => null));
    if (!result.success)
      throw new DeliveryError("TELEGRAM_RESPONSE_UNCERTAIN", "uncertain");
    return `tg:${chatId}:${result.data.result.message_id}`;
  };
}
