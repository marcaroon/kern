import { describe, it, expect, vi, afterEach } from "vitest";
import { amountsIn, fallback, intentSchema, interpret } from "@/services/ai";
import { totals, budgetUsage } from "@/services/finance";
import { dateRange, localDate, nextOccurrence } from "@/lib/time";
import { transactionInput, money } from "@/lib/validation";
import {
  assertOwner,
  assertInternal,
  assertOrigin,
  readBody,
} from "@/lib/security";
import { resolveMatch } from "@/services/records";
import { boundary, respond, AppError } from "@/lib/errors";

afterEach(() => vi.unstubAllEnvs());
const now = new Date("2026-10-12T01:00:00Z");
describe("exact rupiah and validated intent", () => {
  it("extracts explicit Indonesian amounts exactly", () => {
    expect(amountsIn("35 ribu")).toEqual(["35000"]);
    expect(amountsIn("Rp1.250.000")).toEqual(["1250000"]);
    expect(amountsIn("9007199254740993")).toEqual(["9007199254740993"]);
    const parsed = intentSchema.parse(
      fallback("Catat pengeluaran 35 ribu buat makan siang QRIS.", now),
    );
    expect(parsed.entities).toMatchObject({
      amount: "35000",
      type: "expense",
      category: "food",
      paymentMethod: "QRIS",
    });
  });
  it("rejects floating, negative, ambiguous currency and overflow amounts", () => {
    for (const value of ["0", "-1", "1.5", "1,5", "9223372036854775808"])
      expect(money.safeParse(value).success).toBe(false);
    for (const text of [
      "pengeluaran 35 atau 40 ribu makan",
      "pengeluaran 1,5 juta makan",
      "pengeluaran 50 USD makan",
      "pengeluaran 5000 kemarin makan",
    ])
      expect(fallback(text, now).intent).toBe("clarify");
    expect(
      transactionInput.safeParse({
        type: "transfer",
        amount: "10",
        occurredAt: now.toISOString(),
        category: "transfer",
        description: "x",
      }).success,
    ).toBe(false);
  });
  it("excludes transfers and voids, maintains exact sums above Number precision", () => {
    const result = totals([
      { type: "expense", amount: 9007199254740993n, category: "food" },
      { type: "expense", amount: 7n, category: "food" },
      { type: "transfer", amount: 400n, category: "other" },
      { type: "income", amount: 20n, category: "salary" },
      { type: "expense", amount: 50n, category: "food", status: "void" },
    ]);
    expect(result.expense).toBe(9007199254741000n);
    expect(result.income).toBe(20n);
    expect(result.categories.food).toBe(result.expense);
  });
  it("calculates exact threshold crossings", () => {
    expect(budgetUsage(79n, 100n, 80).warning).toBe(false);
    expect(budgetUsage(80n, 100n, 80).warning).toBe(true);
    expect(budgetUsage(100n, 100n, 80).exceeded).toBe(true);
  });
  it("works without optional AI credentials, without fabricated success", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect((await interpret("Bantuan", now)).intent).toBe("help");
    expect((await interpret("/start", now)).intent).toBe("help");
    expect((await interpret("/help@kern_bot", now)).intent).toBe("help");
    expect(
      (await interpret("Apa rahasia yang pernah saya simpan?", now)).intent,
    ).toBe("clarify");
    expect(
      fallback("Ingatkan gue bayar tagihan.", now).missing_fields,
    ).toContain("scheduledAt");
    expect(
      fallback("Catat ide bikin SaaS untuk klinik hewan.", now).intent,
    ).toBe("create_note");
  });
});
describe("WIB dates and recurring reminders", () => {
  it("uses tomorrow in Jakarta instead of the UTC date", () => {
    const parsed = fallback(
      "Ingatkan gue besok jam 9 pagi buat follow up vendor.",
      new Date("2026-10-11T18:00:00Z"),
    );
    expect(localDate(parsed.entities.date!).toISOString()).toBe(
      "2026-10-13T02:00:00.000Z",
    );
    expect(dateRange("today", now).start.toISOString()).toBe(
      "2026-10-11T17:00:00.000Z",
    );
    expect(dateRange("week", now).start.toISOString()).toBe(
      "2026-10-11T17:00:00.000Z",
    );
  });
  it("clamps monthly dates while preserving the original anchor", () => {
    const jan = new Date("2026-01-31T02:00:00Z");
    const feb = nextOccurrence(jan, "monthly", 31, jan)!;
    expect(feb.toISOString()).toBe("2026-02-28T02:00:00.000Z");
    expect(nextOccurrence(feb, "monthly", 31, feb)?.toISOString()).toBe(
      "2026-03-31T02:00:00.000Z",
    );
  });
  it("catches up once and advances past now for daily/weekly/monthly", () => {
    const start = new Date("2020-01-31T02:00:00Z");
    for (const recurrence of ["daily", "weekly", "monthly"])
      expect(
        nextOccurrence(start, recurrence, 31, now)!.getTime(),
      ).toBeGreaterThan(now.getTime());
    expect(nextOccurrence(start, "once", 31, now)).toBeNull();
  });
});
describe("security boundaries and honest delivery", () => {
  it("denies unauthenticated, non-owner and unconfigured internal callers", () => {
    expect(() => assertOwner(undefined, "owner")).toThrow();
    expect(() => assertOwner("other", "owner")).toThrow();
    expect(assertOwner("owner", "owner")).toBe("owner");
    expect(() => assertInternal("Bearer bad", "s".repeat(32))).toThrow();
    expect(() => assertInternal(null, undefined)).toThrow();
    expect(() =>
      assertInternal("Bearer " + "s".repeat(32), "s".repeat(32)),
    ).not.toThrow();
    expect(() =>
      assertOrigin(
        new Request("http://localhost:3000/api/tasks", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow();
  });
  it("limits request bytes including missing Content-Length", async () => {
    await expect(
      readBody(
        new Request("http://localhost", { method: "POST", body: "123456" }),
        5,
      ),
    ).rejects.toThrow();
  });
  it("refuses ambiguous task selections", () => {
    expect(() =>
      resolveMatch([
        { id: "a", title: "Vendor 1" },
        { id: "b", title: "Vendor 2" },
      ]),
    ).toThrow("Ada beberapa");
  });
  it("serializes bigint and hides internal exceptions", async () => {
    expect(
      (await respond({ amount: 9007199254740993n }).json()).data.amount,
    ).toBe("9007199254740993");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await boundary(async () => {
      throw new Error("secret-token");
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-token");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-token");
    spy.mockRestore();
    expect(
      (
        await boundary(async () => {
          throw new AppError("FORBIDDEN", 403);
        })
      ).status,
    ).toBe(403);
  });
});
