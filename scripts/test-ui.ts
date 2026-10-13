import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
const server = await createServer({
  root: resolve("tests/ui"),
  configFile: false,
  resolve: {
    alias: {
      "next/navigation": resolve("tests/ui/navigation.tsx"),
      "next/link": resolve("tests/ui/navigation.tsx"),
    },
  },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
  css: { postcss: resolve(".") },
});
await server.listen();
const origin = server.resolvedUrls!.local[0];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const id = "11111111-1111-4111-8111-111111111111";
const stamp = "2026-10-12T01:00:00.000Z";
const task = {
  id,
  title: "[TEST] Follow up vendor",
  description: null,
  priority: 1,
  status: "open",
  dueAt: stamp,
  project: null,
  updatedAt: stamp,
};
const transaction = {
  id,
  description: "[TEST] Makan siang",
  type: "expense",
  category: "food",
  amount: "35000",
  occurredAt: stamp,
  status: "active",
  updatedAt: stamp,
  paymentMethod: "QRIS",
  accountId: null,
  toAccountId: null,
};
const reminder = {
  id,
  title: "[TEST] Follow up vendor",
  scheduledAt: "2026-10-13T02:00:00.000Z",
  nextRunAt: "2026-10-13T02:00:00.000Z",
  recurrence: "once",
  status: "active",
  deliveryStatus: "pending",
  updatedAt: stamp,
};
const note = {
  id,
  title: "[TEST] Ide SaaS klinik hewan",
  content: "Catatan sintetis khusus pengujian UI.",
  tags: ["ide"],
  category: "idea",
  project: null,
  archived: false,
  updatedAt: stamp,
};
const budget = {
  id,
  category: "food",
  month: "2026-10",
  amount: "1000000",
  spent: "35000",
  percent: "3",
  warningPercent: 80,
  warning: false,
};
const summary = {
  income: "5000000",
  expense: "35000",
  balance: "4965000",
  count: 2,
  categories: { food: "35000" },
};
const fixtures: Record<string, unknown> = {
  dashboard: {
    month: summary,
    day: summary,
    previousMonth: { ...summary, count: 0 },
    budgets: [budget],
    tasks: [task],
    overdue: 1,
    reminders: [reminder],
    transactions: [transaction],
    notes: [note],
    sync: [{ status: "pending", _count: 1 }],
    jobs: [],
  },
  tasks: { rows: [task], count: 1 },
  transactions: { rows: [transaction], count: 1 },
  notes: { rows: [note], count: 1 },
  reminders: { rows: [reminder], count: 1 },
  budgets: { rows: [budget] },
  accounts: { rows: [] },
  health: {
    database: "connected",
    integrations: {
      telegram: false,
      ai: false,
      sheets: false,
      automation: false,
    },
    jobs: [
      {
        id,
        status: "uncertain",
        attempts: 1,
        lastError: "TELEGRAM_SEND_UNCERTAIN",
      },
    ],
    sync: [],
    inbox: [],
    note: "Synthetic fixture; no actual provider connection.",
  },
};
const writes: {
  resource: string;
  method: string;
  data: Record<string, unknown>;
}[] = [];
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    resource = new URL(request.url()).pathname.split("/")[2];
  if (request.method() !== "GET")
    writes.push({
      resource,
      method: request.method(),
      data: request.postDataJSON(),
    });
  await route.fulfill({ json: { data: fixtures[resource] || {} } });
});
page.on("dialog", (dialog) => dialog.accept());
try {
  await mkdir(".local/ui", { recursive: true });
  for (const section of [
    "home",
    "transactions",
    "tasks",
    "reminders",
    "notes",
    "budgets",
    "settings",
  ]) {
    await page.goto(
      new URL(
        section === "home" ? "/app" : `/app/${section}`,
        origin,
      ).toString(),
    );
    await expect(page.locator("main h1")).toBeVisible();
    await expect(
      page.getByText(/Memuat data|Memuat ringkasan|Memeriksa koneksi/),
    ).toHaveCount(0);
    if (section === "home")
      await page.screenshot({
        path: ".local/ui/dashboard-desktop.png",
        fullPage: true,
      });
    if (section === "tasks") {
      await page.getByRole("button", { name: "Tambah", exact: true }).click();
      await page.getByLabel("Judul *").fill("Task dari pengujian browser");
      await page.getByRole("button", { name: "Simpan", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(writes.at(-1)).toMatchObject({
        resource: "tasks",
        method: "POST",
        data: {
          title: "Task dari pengujian browser",
          priority: 2,
          status: "open",
          dueAt: null,
        },
      });
      await page.getByRole("button", { name: "Lihat / ubah" }).click();
      await page
        .getByLabel("Status", { exact: true })
        .selectOption("completed");
      await page.getByRole("button", { name: "Simpan", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(writes.at(-1)?.data).toMatchObject({
        status: "completed",
        confirmed: true,
        expectedUpdatedAt: stamp,
      });
    }
    if (section === "transactions") {
      await page.getByRole("button", { name: "Lihat / ubah" }).click();
      await page.getByRole("button", { name: "Batalkan transaksi" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(writes.at(-1)?.data).toMatchObject({
        action: "void",
        confirmed: true,
        expectedUpdatedAt: stamp,
      });
    }
    if (section === "settings") {
      await page.getByRole("button", { name: "Coba ulang" }).click();
      await expect.poll(() => writes.at(-1)?.resource).toBe("jobs");
      expect(writes.at(-1)?.data).toMatchObject({
        acknowledgeDuplicateRisk: true,
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL("/app", origin).toString());
  await expect(
    page.getByText("Rp35.000", { exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/ui/dashboard-mobile.png",
    fullPage: true,
  });
  await page.route("**/api/notes**", (route) =>
    route.fulfill({
      status: 503,
      json: { error: { message: "Database tidak tersedia (test)." } },
    }),
  );
  await page.goto(new URL("/app/notes", origin).toString());
  await expect(page.getByRole("alert")).toContainText(
    "Database tidak tersedia",
  );
  expect(errors).toEqual([]);
  console.log(
    "PASS: 7 dashboard views, desktop/mobile overflow, create/complete task, void transaction, uncertain-send confirmation, and error state. Test fixtures only.",
  );
} finally {
  await browser.close();
  await server.close();
}
