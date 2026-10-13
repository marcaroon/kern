import { it, expect, vi, afterEach } from "vitest";
import { AppError } from "@/lib/errors";
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireOwner: auth }));
import { handleApi } from "@/controllers/api";
import { internal } from "@/controllers/internal";
import { receiveTelegram } from "@/controllers/webhook";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("requires dashboard authorization before touching the database", async () => {
  auth.mockRejectedValue(new AppError("UNAUTHENTICATED", 401));
  const response = await handleApi(
    new Request("http://localhost/api/transactions"),
    { params: Promise.resolve({ resource: "transactions" }) },
  );
  expect(response.status).toBe(401);
});
it("rejects unknown API resources with a consistent validation response", async () => {
  auth.mockResolvedValue("owner");
  const response = await handleApi(new Request("http://localhost/api/random"), {
    params: Promise.resolve({ resource: "random" }),
  });
  expect(response.status).toBe(422);
  expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
});
it("rejects internal calls without the dedicated service secret", async () => {
  vi.stubEnv("KERN_INTERNAL_API_SECRET", "x".repeat(32));
  expect(
    (
      await internal(
        new Request("http://localhost/api/internal/dispatch", {
          method: "POST",
        }),
        { params: Promise.resolve({ operation: "dispatch" }) },
      )
    ).status,
  ).toBe(401);
});
const update = (secret?: string) =>
  new Request("http://localhost/api/webhooks/telegram", {
    method: "POST",
    headers: secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {},
    body: "{}",
  });
it("hides the Telegram webhook unless webhook mode is selected", async () => {
  vi.stubEnv("TELEGRAM_MODE", "");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s".repeat(32));
  expect((await receiveTelegram(update("s".repeat(32)))).status).toBe(404);
});
it("rejects Telegram updates without the exact long webhook secret", async () => {
  vi.stubEnv("TELEGRAM_MODE", "webhook");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s".repeat(32));
  expect((await receiveTelegram(update())).status).toBe(401);
  expect((await receiveTelegram(update("s".repeat(31)))).status).toBe(401);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "short");
  expect((await receiveTelegram(update("short"))).status).toBe(401);
});
