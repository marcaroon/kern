import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { telegramSender } from "@/integrations/telegram";
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
