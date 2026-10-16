import { z } from "zod";
import type { Database } from "@/lib/db";
import { allowedTelegramIds, configured, required } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { DeliveryError, type Outbound } from "@/services/queue";
const audioSchema = z.object({
  file_id: z.string().min(1).max(300),
  duration: z.number().int(),
  mime_type: z.string().optional(),
  file_size: z.number().int().optional(),
});
const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      from: z.object({ id: z.number().int(), is_bot: z.boolean() }).optional(),
      text: z.string().max(6000).optional(),
      caption: z.string().max(1024).optional(),
      photo: z
        .array(
          z.object({
            file_id: z.string().min(1).max(300),
            file_size: z.number().int().optional(),
            width: z.number().int(),
            height: z.number().int(),
          }),
        )
        .optional(),
      document: z
        .object({
          file_id: z.string().min(1).max(300),
          mime_type: z.string().optional(),
          file_size: z.number().int().optional(),
        })
        .optional(),
      voice: audioSchema.optional(),
      audio: audioSchema.optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().min(1).max(100),
      from: z.object({ id: z.number().int(), is_bot: z.boolean() }),
      data: z.string().max(64).optional(),
      message: z
        .object({
          message_id: z.number().int(),
          chat: z.object({ id: z.number().int(), type: z.string() }),
        })
        .optional(),
    })
    .optional(),
});
// Button taps become the same deterministic commands a user could type.
const buttonCommands: Record<string, string> = {
  ok: "konfirmasi",
  no: "batal",
  paid: "bayar tagihan",
  settle: "lunas",
  done: "habit selesai",
  skip: "habit lewat",
};
export function buttonCommand(data: string | undefined) {
  const match = data?.match(/^(ok|no|paid|settle|done|skip):([0-9a-f-]{36})$/);
  return match ? `${buttonCommands[match[1]]} ${match[2]}` : null;
}
type Callback = NonNullable<z.infer<typeof updateSchema>["callback_query"]>;
function ownerCallback(item: unknown, allowed: string[]) {
  const callback = updateSchema.safeParse(item).data?.callback_query;
  if (
    !callback?.message ||
    callback.message.chat.type !== "private" ||
    callback.from.is_bot ||
    callback.from.id !== callback.message.chat.id ||
    !allowed.includes(String(callback.from.id))
  )
    return null;
  return callback as Callback & { message: NonNullable<Callback["message"]> };
}
const envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
});
export type TelegramUpdate = z.infer<typeof updateSchema>;
type TelegramMessage = NonNullable<TelegramUpdate["message"]>;
// Vision providers accept inline images of a few MB; larger files are refused up front.
export const maxImageBytes = 4 * 1024 * 1024;
const imageTypes = ["image/jpeg", "image/png", "image/webp"];
// Picks the sharpest photo size within the limit, or an image sent as a file.
export function messageImage(message: TelegramMessage) {
  if (message.photo?.length) {
    const fitting = message.photo.filter(
      (p) => (p.file_size ?? 0) <= maxImageBytes,
    );
    const best = fitting.sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0];
    return best ? { fileId: best.file_id, mime: "image/jpeg" } : "too_large";
  }
  const doc = message.document;
  if (doc?.mime_type && imageTypes.includes(doc.mime_type))
    return (doc.file_size ?? 0) <= maxImageBytes
      ? { fileId: doc.file_id, mime: doc.mime_type }
      : "too_large";
  return null;
}
// Voice notes up to 5 minutes; transcription APIs accept far larger files.
export const maxAudioBytes = 8 * 1024 * 1024;
const maxAudioSeconds = 300;
const audioTypes = /^audio\/(ogg|mpeg|mp4|m4a|x-m4a|wav|x-wav|webm|aac|opus)$/;
export function messageAudio(message: TelegramMessage) {
  const audio = message.voice ?? message.audio;
  if (!audio) return null;
  const mime = audio.mime_type || "audio/ogg";
  if (!audioTypes.test(mime)) return null;
  return audio.duration > maxAudioSeconds ||
    (audio.file_size ?? 0) > maxAudioBytes
    ? "too_large"
    : { fileId: audio.file_id, mime };
}
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
    const callback = ownerCallback(item, allowed);
    const command = buttonCommand(callback?.data);
    if (callback && command) {
      // The callback ID is unique, so a redelivered tap is stored once.
      const result = await database.inboxMessage.createMany({
        data: {
          id: `tgcb:${callback.id}`,
          ownerId,
          sender: String(callback.message.chat.id),
          receivedAt: now,
          availableAt: now,
          text: command,
        },
        skipDuplicates: true,
      });
      accepted += result.count;
      continue;
    }
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
    const image = messageImage(message);
    const audio = image ? null : messageAudio(message);
    const media = image ?? audio;
    const result = await database.inboxMessage.createMany({
      data: {
        id: inboxId(message.chat.id, message.message_id),
        ownerId,
        sender: String(message.chat.id),
        receivedAt,
        availableAt: now,
        text:
          message.text !== undefined
            ? message.text
            : image === "too_large"
              ? "[IMAGE_TOO_LARGE]"
              : audio === "too_large"
                ? "[AUDIO_TOO_LONG]"
                : media
                  ? (message.caption ?? "")
                  : "[UNSUPPORTED_MEDIA]",
        ...(media && media !== "too_large"
          ? { fileId: media.fileId, fileMime: media.mime }
          : {}),
      },
      skipDuplicates: true,
    });
    accepted += result.count;
  }
  return { accepted };
}
// Stops the button's loading spinner and removes the keyboard so it cannot be tapped
// twice. Best effort: the tap is already stored, and failures change nothing.
export async function acknowledgeCallbacks(
  raw: unknown[],
  allowed: string[],
  transport: typeof fetch = fetch,
) {
  if (!configured("TELEGRAM_BOT_TOKEN")) return 0;
  let acknowledged = 0;
  for (const item of raw) {
    const callback = ownerCallback(item, allowed);
    if (!callback) continue;
    const known = buttonCommand(callback.data) !== null;
    await call(
      "answerCallbackQuery",
      {
        callback_query_id: callback.id,
        text: known ? "Siap, aku proses…" : "Tombol ini sudah tidak berlaku.",
      },
      transport,
      5000,
    ).catch(() => undefined);
    if (known)
      await call(
        "editMessageReplyMarkup",
        {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] },
        },
        transport,
        5000,
      ).catch(() => undefined);
    acknowledged++;
  }
  return acknowledged;
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
// Downloads an image into memory for the vision provider. The file URL embeds the bot
// token, so it is never passed to a third party, stored or included in errors.
export async function downloadTelegramImage(
  fileId: string,
  transport: typeof fetch = fetch,
) {
  return downloadTelegramFile(fileId, transport, maxImageBytes);
}
export async function downloadTelegramFile(
  fileId: string,
  transport: typeof fetch = fetch,
  maxBytes = maxImageBytes,
): Promise<Buffer> {
  if (!configured("TELEGRAM_BOT_TOKEN"))
    throw new AppError("TELEGRAM_NOT_CONFIGURED", 503);
  const started = Date.now();
  try {
    return await downloadOnce(fileId, transport, maxBytes);
  } catch (error) {
    // Telegram's file servers occasionally stall; retry once if time allows.
    if (
      !(error instanceof AppError) ||
      error.code !== "TELEGRAM_FILE_UNAVAILABLE" ||
      Date.now() - started > 12000
    )
      throw error;
    return downloadOnce(fileId, transport, maxBytes);
  }
}
const fileUnavailable = () =>
  new AppError(
    "TELEGRAM_FILE_UNAVAILABLE",
    503,
    "Aku belum berhasil mengambil filenya dari Telegram. Coba kirim ulang, ya. Belum ada yang aku simpan.",
  );
async function downloadOnce(
  fileId: string,
  transport: typeof fetch,
  maxBytes: number,
) {
  let path: string;
  try {
    const response = await call(
      "getFile",
      { file_id: fileId },
      transport,
      10000,
    );
    const parsed = z
      .object({
        ok: z.literal(true),
        result: z.object({
          file_path: z.string().regex(/^[\w./-]+$/),
          file_size: z.number().int().optional(),
        }),
      })
      .safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) throw new Error("TELEGRAM_FILE");
    if ((parsed.data.result.file_size ?? 0) > maxBytes)
      throw new AppError(
        "IMAGE_TOO_LARGE",
        413,
        "Filenya terlalu besar buat aku proses. Coba kirim yang lebih kecil, ya.",
      );
    path = parsed.data.result.file_path;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw fileUnavailable();
  }
  let bytes: ArrayBuffer;
  try {
    const response = await transport(
      `https://api.telegram.org/file/bot${required("TELEGRAM_BOT_TOKEN")}/${path}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new Error("TELEGRAM_FILE");
    bytes = await response.arrayBuffer();
  } catch {
    throw fileUnavailable();
  }
  if (bytes.byteLength > maxBytes)
    throw new AppError(
      "IMAGE_TOO_LARGE",
      413,
      "Filenya terlalu besar buat aku proses. Coba kirim yang lebih kecil, ya.",
    );
  return Buffer.from(bytes);
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
    allowed_updates: ["message", "callback_query"],
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
  await acknowledgeCallbacks(updates, allowedTelegramIds(), transport);
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
          ...(payload.buttons?.length
            ? {
                reply_markup: {
                  inline_keyboard: payload.buttons.map((row) =>
                    row.map((b) => ({ text: b.text, callback_data: b.data })),
                  ),
                },
              }
            : {}),
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
