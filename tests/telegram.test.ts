import { it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  downloadTelegramImage,
  messageImage,
  setupReplies,
  telegramMode,
  telegramSender,
} from "@/integrations/telegram";
import { DeliveryError } from "@/services/queue";
beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:secret-token");
  vi.stubEnv("TELEGRAM_OWNER_USER_ID", "1001, 2002");
});
afterEach(() => vi.unstubAllEnvs());
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));
async function failure(transport: typeof fetch, chatId?: string) {
  try {
    await telegramSender(transport)({ text: "hai", chatId });
  } catch (error) {
    expect(error).toBeInstanceOf(DeliveryError);
    const e = error as DeliveryError;
    // Error codes are safe to store: never the token or provider description.
    expect(e.code).not.toContain("secret-token");
    return [e.code, e.disposition];
  }
  throw new Error("expected failure");
}
it("sends to the first allowlisted owner and returns a stable provider ID", async () => {
  const transport = reply(200, { ok: true, result: { message_id: 77 } });
  expect(
    await telegramSender(transport as unknown as typeof fetch)({
      text: "x".repeat(5000),
    }),
  ).toBe("tg:1001:77");
  const body = JSON.parse(
    String(((transport.mock.calls[0] as unknown[])[1] as RequestInit).body),
  );
  expect(body.chat_id).toBe("1001");
  expect(body.text).toHaveLength(4096);
});
it("refuses recipients outside the allowlist or without configuration", async () => {
  const transport = reply(200, { ok: true, result: { message_id: 1 } });
  expect(await failure(transport as unknown as typeof fetch, "3003")).toEqual([
    "TELEGRAM_OWNER_NOT_CONFIGURED",
    "blocked",
  ]);
  expect(transport).not.toHaveBeenCalled();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  expect(await failure(transport as unknown as typeof fetch)).toEqual([
    "TELEGRAM_NOT_CONFIGURED",
    "blocked",
  ]);
});
it("maps provider outcomes to honest retry dispositions", async () => {
  const cases: [number, unknown, string, string][] = [
    [
      429,
      { ok: false, parameters: { retry_after: 3 } },
      "TELEGRAM_RATE_LIMIT",
      "retry",
    ],
    [502, {}, "TELEGRAM_SERVER_UNCERTAIN", "uncertain"],
    [
      403,
      { ok: false, description: "bot was blocked" },
      "TELEGRAM_403",
      "blocked",
    ],
    [401, {}, "TELEGRAM_401", "blocked"],
    [409, {}, "TELEGRAM_409", "failed"],
    [200, { ok: true, result: {} }, "TELEGRAM_RESPONSE_UNCERTAIN", "uncertain"],
  ];
  for (const [status, body, code, disposition] of cases)
    expect(
      await failure(reply(status, body) as unknown as typeof fetch),
    ).toEqual([code, disposition]);
  const timeout = vi.fn(async () => {
    throw new Error("https://api.telegram.org/bot123:secret-token timed out");
  });
  expect(await failure(timeout as unknown as typeof fetch)).toEqual([
    "TELEGRAM_SEND_UNCERTAIN",
    "uncertain",
  ]);
});
it("defaults to webhook on Vercel and honours an explicit mode", () => {
  vi.stubEnv("TELEGRAM_MODE", "");
  vi.stubEnv("VERCEL", "");
  expect(telegramMode()).toBe("polling");
  vi.stubEnv("VERCEL", "1");
  expect(telegramMode()).toBe("webhook");
  vi.stubEnv("TELEGRAM_MODE", "polling");
  expect(telegramMode()).toBe("polling");
});
it("tells private senders their own ID only while no owner is configured", async () => {
  const transport = reply(200, { ok: true, result: { message_id: 1 } });
  const message = (id: number, type = "private", isBot = false) => ({
    update_id: id,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: type === "private" ? id : -100, type },
      from: { id, is_bot: isBot },
      text: "/start",
    },
  });
  const updates = [
    message(555),
    message(556, "group"),
    message(557, "private", true),
  ];
  expect(
    await setupReplies(updates, [], transport as unknown as typeof fetch),
  ).toBe(1);
  const body = JSON.parse(
    String(((transport.mock.calls[0] as unknown[])[1] as RequestInit).body),
  );
  expect(body.chat_id).toBe(555);
  expect(body.text).toContain("555");
  expect(
    await setupReplies(updates, ["1001"], transport as unknown as typeof fetch),
  ).toBe(0);
  expect(transport).toHaveBeenCalledTimes(1);
});
it("downloads a receipt image without exposing the token in errors", async () => {
  const urls: string[] = [];
  const transport = vi.fn(async (url: string) => {
    urls.push(url);
    return url.endsWith("/getFile")
      ? new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: "photos/file_1.jpg", file_size: 5 },
          }),
        )
      : new Response("bytes");
  });
  const data = await downloadTelegramImage(
    "abc",
    transport as unknown as typeof fetch,
  );
  expect(data.toString()).toBe("bytes");
  expect(urls[1]).toBe(
    "https://api.telegram.org/file/bot123:secret-token/photos/file_1.jpg",
  );
  for (const broken of [
    vi.fn(async () => new Response("{}", { status: 400 })),
    vi.fn(async () => {
      throw new Error("https://api.telegram.org/bot123:secret-token/getFile");
    }),
  ]) {
    const error = await downloadTelegramImage(
      "abc",
      broken as unknown as typeof fetch,
    ).catch((e) => e);
    expect(error.code).toBe("TELEGRAM_FILE_UNAVAILABLE");
    expect(`${error.message}${error.code}`).not.toContain("secret-token");
  }
  const huge = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: "photos/x.jpg", file_size: 50_000_000 },
        }),
      ),
  );
  expect(
    (
      await downloadTelegramImage("abc", huge as unknown as typeof fetch).catch(
        (e) => e,
      )
    ).code,
  ).toBe("IMAGE_TOO_LARGE");
});
it("accepts image documents and refuses other files", () => {
  const base = {
    message_id: 1,
    date: 1,
    chat: { id: 1, type: "private" },
  };
  expect(
    messageImage({
      ...base,
      document: { file_id: "d", mime_type: "image/png", file_size: 10 },
    }),
  ).toEqual({ fileId: "d", mime: "image/png" });
  expect(
    messageImage({
      ...base,
      document: { file_id: "d", mime_type: "application/pdf" },
    }),
  ).toBeNull();
  expect(
    messageImage({
      ...base,
      document: { file_id: "d", mime_type: "image/jpeg", file_size: 9e6 },
    }),
  ).toBe("too_large");
});
