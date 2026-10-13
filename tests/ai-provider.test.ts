import { it, expect, vi, afterEach } from "vitest";
const { parse, claudeParse } = vi.hoisted(() => ({
  parse: vi.fn(),
  claudeParse: vi.fn(),
}));
vi.mock("openai", () => ({
  default: class {
    responses = { parse };
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse: claudeParse };
  },
}));
import { aiProvider, interpret, intent } from "@/services/ai";
function only(provider: "openai" | "anthropic" | "") {
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "AI_PROVIDER",
  ])
    vi.stubEnv(name, "");
  if (provider === "openai") {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubEnv("OPENAI_MODEL", "test-only");
  }
  if (provider === "anthropic") {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only");
    vi.stubEnv("ANTHROPIC_MODEL", "test-only");
  }
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("falls back safely when the configured AI provider fails", async () => {
  only("openai");
  parse.mockRejectedValue(new Error("simulated provider outage"));
  expect((await interpret("Pengeluaran 35000 makan siang")).intent).toBe(
    "create_transaction",
  );
  expect((await interpret("Pertanyaan tanpa pola yang didukung")).intent).toBe(
    "clarify",
  );
});
it("rejects invented model amounts and malformed structured output", async () => {
  only("openai");
  parse.mockResolvedValueOnce({
    output_parsed: intent("create_transaction", {
      type: "expense",
      amount: "999999",
      currency: "IDR",
    }),
  });
  expect((await interpret("Catat pengeluaran 35000 makan")).intent).toBe(
    "clarify",
  );
  parse.mockResolvedValueOnce({
    output_parsed: { intent: "execute_sql", sql: "DROP TABLE" },
  });
  expect((await interpret("jalankan perintah asing")).intent).toBe("clarify");
});
it("selects the configured provider and honours an explicit choice", () => {
  only("");
  expect(aiProvider()).toBeNull();
  only("anthropic");
  expect(aiProvider()).toBe("anthropic");
  vi.stubEnv("OPENAI_API_KEY", "test-only");
  vi.stubEnv("OPENAI_MODEL", "test-only");
  expect(aiProvider()).toBe("openai");
  vi.stubEnv("AI_PROVIDER", "anthropic");
  expect(aiProvider()).toBe("anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  // An explicit but unconfigured provider never silently switches vendors.
  expect(aiProvider()).toBeNull();
  vi.stubEnv("AI_PROVIDER", "unknown");
  expect(aiProvider()).toBeNull();
});
it("validates Anthropic structured output like any other provider", async () => {
  only("anthropic");
  claudeParse.mockResolvedValueOnce({
    stop_reason: "end_turn",
    parsed_output: intent("create_task", { title: "revisi dashboard" }),
  });
  expect((await interpret("tolong buatkan task revisi dashboard")).intent).toBe(
    "create_task",
  );
  expect(parse).not.toHaveBeenCalled();
  claudeParse.mockResolvedValueOnce({
    stop_reason: "end_turn",
    parsed_output: intent("create_transaction", {
      type: "expense",
      amount: "999999",
      currency: "IDR",
    }),
  });
  expect((await interpret("Catat pengeluaran 35000 makan")).intent).toBe(
    "clarify",
  );
});
it("falls back when Anthropic refuses, truncates or fails", async () => {
  only("anthropic");
  claudeParse.mockResolvedValueOnce({
    stop_reason: "refusal",
    parsed_output: null,
  });
  expect((await interpret("Pengeluaran 35000 makan siang")).intent).toBe(
    "create_transaction",
  );
  claudeParse.mockResolvedValueOnce({
    stop_reason: "max_tokens",
    parsed_output: intent("help"),
  });
  expect((await interpret("sesuatu yang tidak jelas")).intent).toBe("clarify");
  claudeParse.mockRejectedValueOnce(new Error("simulated outage"));
  expect((await interpret("Bantuan")).intent).toBe("help");
});
