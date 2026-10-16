import { it, expect, describe, vi, afterEach } from "vitest";
import {
  allocate,
  normalizeReceipt,
  planSplit,
  receiptAmount,
  splitBill,
  type ReceiptReading,
} from "@/services/receipts";
import { fallback } from "@/services/ai";

const now = new Date("2026-10-12T05:00:00Z");
const zone = "Asia/Jakarta";
const reading = (over: Partial<ReceiptReading> = {}): ReceiptReading => ({
  is_receipt: true,
  type: "expense",
  merchant: "Warung Bu Sri",
  date: null,
  currency: "IDR",
  items: [
    { name: "Nasi goreng", quantity: 1, amount: "25.000" },
    { name: "Mie ayam", quantity: 1, amount: "20000" },
    { name: "Es teh", quantity: 2, amount: "Rp 10.000" },
  ],
  subtotal: "55000",
  tax: "5.500",
  service: null,
  discount: null,
  total: "60.500",
  payment_method: "QRIS",
  category: "food",
  problem: null,
  ...over,
});
afterEach(() => vi.unstubAllEnvs());

describe("receipt amounts and allocation", () => {
  it("reads printed rupiah formats as whole integers", () => {
    expect(receiptAmount("45.000")).toBe(45000n);
    expect(receiptAmount("Rp 1.250.000")).toBe(1250000n);
    expect(receiptAmount("45.000,00")).toBe(45000n);
    expect(receiptAmount("45,000.00")).toBe(45000n);
    expect(receiptAmount(null)).toBe(0n);
    expect(receiptAmount("-")).toBe(0n);
    // Shapes returned by a live vision model on a real receipt (15 Oct 2026).
    expect(receiptAmount("/ 70,000")).toBe(70000n);
    expect(receiptAmount("7,000 x 10 = 70,000")).toBe(70000n);
    expect(receiptAmount("This amount is uncertain or not specified.")).toBe(
      0n,
    );
    expect(receiptAmount("12345678901234567890")).toBe(0n);
  });
  it("allocates exactly, including remainders, negatives and zero weights", () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(allocate(10n, [0n, 0n])).toEqual([5n, 5n]);
    const parts = allocate(5501n, [30000n, 25000n, 7n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(5501n);
    expect(allocate(9007199254740993n, [1n, 2n])).toEqual([
      3002399751580331n,
      6004799503160662n,
    ]);
  });
});
describe("receipt normalisation", () => {
  it("keeps the printed total and the tax as a separate extra", () => {
    const r = normalizeReceipt(reading(), "", now, zone)!;
    expect(r).toMatchObject({
      merchant: "Warung Bu Sri",
      total: "60500",
      extra: "5500",
      paymentMethod: "QRIS",
      category: "food",
      warning: null,
      occurredAt: now.toISOString(),
    });
    expect(r.items.map((i) => i.amount)).toEqual(["25000", "20000", "10000"]);
  });
  it("warns instead of guessing when items and total disagree", () => {
    const r = normalizeReceipt(reading({ total: "90000" }), "", now, zone)!;
    expect(r.total).toBe("90000");
    expect(r.warning).toContain("tidak pas");
  });
  it("computes a missing total only from printed parts", () => {
    expect(
      normalizeReceipt(reading({ total: null }), "", now, zone)!.total,
    ).toBe("60500");
    expect(
      normalizeReceipt(
        reading({ total: null, items: [], tax: null }),
        "",
        now,
        zone,
      ),
    ).toBeNull();
    expect(
      normalizeReceipt(reading({ is_receipt: false }), "", now, zone),
    ).toBeNull();
  });
  it("uses a plausible printed date and refuses future or foreign receipts", () => {
    const old = normalizeReceipt(
      reading({ date: "2026-10-10" }),
      "",
      now,
      zone,
    )!;
    expect(old.occurredAt).toBe("2026-10-10T12:00:00.000+07:00");
    for (const printed of [
      "2026-10-01 18:08:19",
      "2026-10-01T18:08",
      "01/10/2026 18:08",
      "1-10-2026, 18.08",
    ])
      expect(
        normalizeReceipt(reading({ date: printed }), "", now, zone)!.occurredAt,
      ).toMatch(/^2026-10-01T18:08:\d{2}\.000\+07:00$/);
    expect(
      normalizeReceipt(reading({ date: "2027-01-01" }), "", now, zone)!
        .occurredAt,
    ).toBe(now.toISOString());
    expect(() =>
      normalizeReceipt(reading({ currency: "USD" }), "", now, zone),
    ).toThrow("rupiah");
  });
  it("lets the caption decide income and rejects unknown categories", () => {
    const r = normalizeReceipt(
      reading({ category: "salary" }),
      "ini pemasukan dari klien",
      now,
      zone,
    )!;
    expect(r.type).toBe("income");
    expect(r.category).toBe("salary");
    expect(
      normalizeReceipt(reading({ category: "drop table" }), "", now, zone)!
        .category,
    ).toBe("other");
  });
});
describe("split bill", () => {
  const receipt = normalizeReceipt(reading(), "", now, zone)!;
  it("splits items per person and tax proportionally, summing to the total", () => {
    const { shares, shared } = splitBill(receipt, {
      participants: ["aku", "Budi"],
      assignments: [
        { item: 1, people: ["Aku"] },
        { item: 2, people: ["budi"] },
      ],
      payer: null,
      question: null,
    });
    expect(shares.map((s) => [s.name, s.amount])).toEqual([
      ["Kamu", 33000n],
      ["Budi", 27500n],
    ]);
    expect(shared).toEqual(["Es teh"]);
    expect(shares.reduce((a, s) => a + s.amount, 0n)).toBe(60500n);
  });
  it("distributes a discount and ignores invalid item numbers", () => {
    const discounted = normalizeReceipt(
      reading({ tax: null, discount: "10.000", total: "45000" }),
      "",
      now,
      zone,
    )!;
    const { shares } = splitBill(discounted, {
      participants: ["Kamu", "Sari", "Budi"],
      assignments: [
        { item: 1, people: ["Sari"] },
        { item: 99, people: ["Budi"] },
      ],
      payer: null,
      question: null,
    });
    expect(shares.reduce((a, s) => a + s.amount, 0n)).toBe(45000n);
    expect(shares.every((s) => s.amount >= 0n)).toBe(true);
  });
  it("asks for people instead of splitting to one person", () => {
    expect(() =>
      splitBill(receipt, {
        participants: ["Kamu"],
        assignments: [],
        payer: null,
        question: null,
      }),
    ).toThrow("Dibagi ke siapa");
  });
  it("plans plain equal splits without any AI provider", async () => {
    for (const name of [
      "AI_PROVIDER",
      "GROQ_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
    ])
      vi.stubEnv(name, "");
    expect(
      (await planSplit(receipt, "bagi rata 4 orang")).participants,
    ).toEqual(["Kamu", "Teman 1", "Teman 2", "Teman 3"]);
    expect((await planSplit(receipt, "aku nasi goreng")).question).toContain(
      "berapa orang",
    );
  });
  it("recognises split requests without treating head counts as money", () => {
    expect(fallback("split 300rb bagi 3")).toMatchObject({
      intent: "split_bill",
      entities: { amount: "300000" },
    });
    expect(fallback("patungan 450 ribu ke 3 orang").entities.amount).toBe(
      "450000",
    );
    expect(fallback("bagi rata 4 orang").entities.amount).toBeNull();
  });
});
describe("untrusted model output", () => {
  it("treats sentence amounts as unreadable instead of failing validation", () => {
    const junk = "This amount is uncertain or not specified. Try again.";
    expect(
      normalizeReceipt(
        reading({
          items: reading().items.map((i) => ({ ...i, amount: junk })),
          subtotal: junk,
          total: junk,
          tax: null,
        }),
        "",
        now,
        zone,
      ),
    ).toBeNull();
    const partly = normalizeReceipt(
      reading({
        items: [
          { name: "Sate", quantity: 10, amount: "/ 70,000" },
          { name: "Es", quantity: 1, amount: null },
        ],
        tax: null,
        total: "/ 154,000",
      }),
      "",
      now,
      zone,
    )!;
    expect(partly.total).toBe("154000");
    expect(partly.items).toEqual([{ name: "Sate", amount: "70000" }]);
    expect(partly.warning).toContain("tidak pas");
  });
  it("never throws on oversized model strings", () => {
    expect(() =>
      normalizeReceipt(
        reading({
          merchant: "x".repeat(5000),
          payment_method: "y".repeat(5000),
          problem: "z".repeat(5000),
          items: [{ name: "n".repeat(5000), quantity: null, amount: "5000" }],
          tax: null,
          total: "5000",
        }),
        "",
        now,
        zone,
      ),
    ).not.toThrow();
  });
});
describe("fallback for new features", () => {
  it("understands debt, bill and insight questions without AI", () => {
    expect(fallback("siapa aja yang masih utang?").intent).toBe("list_debts");
    expect(fallback("tagihan bulan ini").intent).toBe("list_bills");
    expect(fallback("gimana keuanganku bulan ini?").intent).toBe(
      "finance_insight",
    );
  });
});
describe("goals helpers", () => {
  it("draws progress and needs per week from integers", async () => {
    const { progressBar, weeklyNeed } = await import("@/services/goals");
    expect(progressBar(0n, 100n)).toBe("░░░░░░░░░░");
    expect(progressBar(55n, 100n)).toBe("▓▓▓▓▓░░░░░");
    expect(progressBar(200n, 100n)).toBe("▓▓▓▓▓▓▓▓▓▓");
    const goal = {
      id: "g",
      name: "Laptop",
      target: 1000n,
      saved: 0n,
      deadline: new Date(now.getTime() + 3 * 7 * 86400000),
      status: "active",
      createdAt: now,
    };
    expect(weeklyNeed(goal, now)).toBe(334n);
    expect(weeklyNeed({ ...goal, deadline: null }, now)).toBeNull();
  });
});
