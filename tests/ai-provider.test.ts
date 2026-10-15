import { it, expect, vi, afterEach } from "vitest";
const { parse, claudeParse, generate, groqCreate, clientOptions } = vi.hoisted(
  () => ({
    groqCreate: vi.fn(),
    clientOptions: vi.fn(),
    parse: vi.fn(),
    claudeParse: vi.fn(),
    generate: vi.fn(),
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) {
      clientOptions(options);
    }
    chat = { completions: { create: groqCreate } };
    responses = { parse };
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse: claudeParse };
  },
}));
vi.mock("@google/genai", async (original) => ({
  ...(await original<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generate };
  },
}));
import { aiProvider, interpret, intent, visionTarget } from "@/services/ai";
import { readReceipt } from "@/services/receipts";
function only(provider: "groq" | "openai" | "anthropic" | "gemini" | "") {
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "AI_PROVIDER",
    "GROQ_API_KEY",
    "GROQ_MODEL",
    "GROQ_VISION_MODEL",
    "AI_VISION_PROVIDER",
  ])
    vi.stubEnv(name, "");
  if (provider === "groq") {
    vi.stubEnv("GROQ_API_KEY", "test-only");
    vi.stubEnv("GROQ_MODEL", "openai/gpt-oss-20b");
  }
  if (provider === "openai") {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubEnv("OPENAI_MODEL", "test-only");
  }
  if (provider === "anthropic") {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only");
    vi.stubEnv("ANTHROPIC_MODEL", "test-only");
  }
  if (provider === "gemini") {
    vi.stubEnv("GEMINI_API_KEY", "test-only");
    vi.stubEnv("GEMINI_MODEL", "test-only");
  }
}
const gemini = (finishReason: string, body: unknown) => ({
  candidates: [{ finishReason }],
  text: typeof body === "string" ? body : JSON.stringify(body),
});
it("uses Groq's server endpoint and strict schema with exact IDR validation", async () => {
  only("groq");
  expect(aiProvider()).toBe("groq");
  const body = intent("create_transaction", {
    type: "expense",
    amount: "35000",
    currency: "IDR",
  });
  groqCreate.mockResolvedValue({
    choices: [
      { finish_reason: "stop", message: { content: JSON.stringify(body) } },
    ],
  });
  expect(await interpret("makan 35rb")).toEqual(body);
  expect(clientOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      baseURL: "https://api.groq.com/openai/v1",
      timeout: 20000,
      maxRetries: 0,
    }),
  );
  expect(groqCreate.mock.calls[0][0].response_format).toMatchObject({
    type: "json_schema",
    json_schema: { strict: true, schema: { additionalProperties: false } },
  });
  expect((await interpret("makan 20rb")).intent).toBe("clarify");
  vi.stubEnv("AI_PROVIDER", "groq");
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "test-only");
  vi.stubEnv("OPENAI_MODEL", "test-only");
  expect(aiProvider()).toBeNull();
});
it("falls back safely on Groq refusal, truncation, invalid output and outage", async () => {
  only("groq");
  groqCreate
    .mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "length",
          message: { content: JSON.stringify(intent("help")) },
        },
      ],
    })
    .mockResolvedValueOnce({
      choices: [
        { finish_reason: "stop", message: { refusal: "no", content: "{}" } },
      ],
    })
    .mockResolvedValueOnce({
      choices: [{ finish_reason: "stop", message: { content: "not JSON" } }],
    })
    .mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: { content: '{"intent":"execute_sql"}' },
        },
      ],
    })
    .mockRejectedValueOnce(new Error("simulated 429"));
  for (let i = 0; i < 4; i++)
    expect((await interpret("pesan ambigu")).intent).toBe("clarify");
  expect((await interpret("pengeluaran 35000 makan")).intent).toBe(
    "create_transaction",
  );
});
it("rejects account names and invented account IDs from the model", async () => {
  only("groq");
  for (const accountId of [
    "Bank Contoh",
    "11111111-1111-4111-8111-111111111111",
  ]) {
    groqCreate.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify(
              intent("create_transaction", {
                type: "expense",
                amount: "50000",
                currency: "IDR",
                title: "Buku",
                accountId,
              }),
            ),
          },
        },
      ],
    });
    const result = await interpret("beli buku 50rb pakai QRIS Bank Contoh");
    expect(result.intent).toBe("clarify");
    expect(result.entities.answer).toContain("rekening");
  }
});
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
it("rejects amounts in a foreign currency even when the model returns them", async () => {
  only("anthropic");
  claudeParse.mockResolvedValueOnce({
    stop_reason: "end_turn",
    parsed_output: intent("create_transaction", {
      type: "expense",
      amount: "20",
      currency: "IDR",
    }),
  });
  expect((await interpret("bayar langganan 20 dolar")).intent).toBe("clarify");
});
it("uses Gemini structured JSON with the same validation", async () => {
  only("gemini");
  expect(aiProvider()).toBe("gemini");
  generate.mockResolvedValueOnce(
    gemini(
      "STOP",
      intent("create_transaction", {
        type: "expense",
        amount: "50000",
        currency: "IDR",
        category: "transport",
        paymentMethod: "GoPay",
      }),
    ),
  );
  const result = await interpret("tadi beli bensin 50rb pakai gopay");
  expect(result).toMatchObject({
    intent: "create_transaction",
    entities: { amount: "50000", category: "transport" },
  });
  const request = generate.mock.calls[0][0];
  expect(request.config.responseMimeType).toBe("application/json");
  expect(request.config.responseJsonSchema).not.toHaveProperty("$schema");
  expect(parse).not.toHaveBeenCalled();
  expect(claudeParse).not.toHaveBeenCalled();
});
it("falls back when Gemini blocks, truncates, returns bad JSON or fails", async () => {
  only("gemini");
  generate
    .mockResolvedValueOnce(gemini("SAFETY", ""))
    .mockResolvedValueOnce(gemini("MAX_TOKENS", intent("help")))
    .mockResolvedValueOnce(gemini("STOP", "{not json"))
    .mockResolvedValueOnce(gemini("STOP", { intent: "execute_sql" }))
    .mockRejectedValueOnce(new Error("429 quota exhausted"));
  expect((await interpret("Pengeluaran 35000 makan siang")).intent).toBe(
    "create_transaction",
  );
  for (const text of ["x", "y", "z"])
    expect((await interpret(text)).intent).toBe("clarify");
  expect((await interpret("Bantuan")).intent).toBe("help");
});
const receiptBody = {
  is_receipt: true,
  type: "expense",
  merchant: "Kopi Kenangan",
  date: null,
  currency: "IDR",
  items: [{ name: "Kopi susu", quantity: 1, amount: "22000" }],
  subtotal: null,
  tax: null,
  service: null,
  discount: null,
  total: "22000",
  payment_method: null,
  category: "food",
  problem: null,
};
const image = { data: Buffer.from("fake-jpeg"), mime: "image/jpeg" };
it("needs an explicit Groq vision model and can use another vision provider", () => {
  only("groq");
  expect(visionTarget()).toBeNull();
  vi.stubEnv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b");
  expect(visionTarget()).toEqual({
    provider: "groq",
    model: "qwen/qwen3.8-27b",
  });
  vi.stubEnv("GEMINI_API_KEY", "test-only");
  vi.stubEnv("GEMINI_MODEL", "gemini-test");
  vi.stubEnv("AI_VISION_PROVIDER", "gemini");
  expect(visionTarget()).toEqual({ provider: "gemini", model: "gemini-test" });
  vi.stubEnv("GEMINI_API_KEY", "");
  // An explicit but unconfigured vision provider never silently switches vendors.
  expect(visionTarget()).toBeNull();
});
it("sends receipt photos inline to Groq and validates the reading", async () => {
  only("groq");
  vi.stubEnv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b");
  groqCreate.mockResolvedValueOnce({
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: `<think>reading</think>${JSON.stringify(receiptBody)}`,
        },
      },
    ],
  });
  expect(await readReceipt(image, "kopi pagi")).toMatchObject({
    merchant: "Kopi Kenangan",
    total: "22000",
  });
  const request = groqCreate.mock.calls[0][0];
  expect(request.model).toBe("qwen/qwen3.8-27b");
  expect(request.response_format.json_schema.strict).toBe(false);
  const content = request.messages[1].content;
  expect(content[1].image_url.url).toBe(
    `data:image/jpeg;base64,${image.data.toString("base64")}`,
  );
  // The caption is passed as context, never as the system prompt.
  expect(request.messages[0].content).not.toContain("kopi pagi");
  groqCreate.mockResolvedValueOnce({
    choices: [{ finish_reason: "stop", message: { content: '{"sql":1}' } }],
  });
  await expect(readReceipt(image, "")).rejects.toThrow("gagal membaca");
});
it("sends receipt photos to Gemini as inline data", async () => {
  only("gemini");
  generate.mockResolvedValueOnce(gemini("STOP", receiptBody));
  await readReceipt(image, "");
  const request = generate.mock.calls[0][0];
  expect(request.contents[0].parts[0].inlineData).toEqual({
    mimeType: "image/jpeg",
    data: image.data.toString("base64"),
  });
  expect(request.config.responseJsonSchema).not.toHaveProperty("$schema");
});
it("passes recent turns and accepts amounts the user stated earlier only", async () => {
  only("groq");
  const body = intent("create_transaction", {
    type: "expense",
    amount: "45000",
    currency: "IDR",
    title: "Makan siang",
  });
  const reply = (value: unknown) => ({
    choices: [
      { finish_reason: "stop", message: { content: JSON.stringify(value) } },
    ],
  });
  groqCreate.mockResolvedValueOnce(reply(body));
  const history = [
    { user: "pengeluaran 45rb", reply: "Buat apa pengeluarannya?" },
  ];
  expect(
    await interpret("makan siang", new Date(), "Asia/Jakarta", history),
  ).toEqual(body);
  const text = groqCreate.mock.calls[0][0].messages[1].content;
  expect(text).toContain("<riwayat>");
  expect(text).toContain("<pesan_baru>\nmakan siang");
  // An amount that only KERN mentioned is never accepted as the user's.
  groqCreate.mockResolvedValueOnce(reply(body));
  expect(
    (
      await interpret("catat yang itu", new Date(), "Asia/Jakarta", [
        { user: "berapa total minggu ini?", reply: "Total Rp45.000" },
      ])
    ).intent,
  ).toBe("clarify");
  // A foreign currency in an unrelated earlier message does not block rupiah.
  groqCreate.mockResolvedValueOnce(reply(body));
  expect(
    (
      await interpret("makan siang 45rb", new Date(), "Asia/Jakarta", [
        { user: "langganan 10 dolar", reply: null },
      ])
    ).intent,
  ).toBe("create_transaction");
});
