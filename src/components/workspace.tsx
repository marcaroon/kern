"use client";
import Link from "next/link";
import { redirect, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useRef } from "react";
import {
  Hexagon,
  LayoutDashboard,
  Wallet,
  CheckSquare,
  Bell,
  NotebookPen,
  SlidersHorizontal,
  Plus,
  ArrowUpRight,
  RefreshCw,
  LogOut,
  Search,
  X,
  CircleAlert,
  Target,
} from "lucide-react";
import { DateTime } from "luxon";
import type { dashboard } from "@/services/reporting";
import type { integrationHealth } from "@/services/health";
type Serialized<T> = T extends Date
  ? string
  : T extends bigint
    ? string
    : T extends Array<infer U>
      ? Serialized<U>[]
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;
type DashboardData = Serialized<Awaited<ReturnType<typeof dashboard>>>;
type HealthData = Serialized<Awaited<ReturnType<typeof integrationHealth>>>;
type Row = { id: string; [key: string]: unknown };
const nav = [
  ["home", "Ringkasan", LayoutDashboard],
  ["transactions", "Transaksi", Wallet],
  ["tasks", "Task", CheckSquare],
  ["reminders", "Pengingat", Bell],
  ["notes", "Catatan", NotebookPen],
  ["budgets", "Anggaran", Target],
  ["settings", "Integrasi", SlidersHorizontal],
] as const;
const descriptions: Record<string, string> = {
  home: "Lihat yang perlu diperhatikan hari ini.",
  transactions: "Semua pergerakan uang yang Anda catat.",
  tasks: "Satu tempat untuk hal yang perlu diselesaikan.",
  reminders: "Jadwal tersimpan, status pengiriman terlihat.",
  notes: "Simpan ide. Temukan kembali saat dibutuhkan.",
  budgets: "Batas bulanan berdasarkan kategori pengeluaran.",
  settings: "Konfigurasi layanan dan pekerjaan yang perlu diperiksa.",
};
const money = (value: unknown) =>
  `Rp${BigInt(String(value || "0")).toLocaleString("id-ID")}`;
const date = (value: unknown) =>
  value
    ? DateTime.fromISO(String(value))
        .setZone("Asia/Jakarta")
        .setLocale("id")
        .toFormat("dd LLL, HH:mm")
    : "—";
const text = (value: unknown) =>
  value === null || value === undefined
    ? "—"
    : Array.isArray(value)
      ? value.join(", ")
      : String(value);
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) redirect("/login");
    throw new Error(body.error?.message || "Layanan belum tersedia.");
  }
  return body.data;
}
export function Workspace({ section }: { section: string }) {
  const router = useRouter();
  const [reload, setReload] = useState(0),
    [editor, setEditor] = useState<Row | null | undefined>(undefined);
  const title = nav.find((n) => n[0] === section)?.[1];
  async function logout() {
    await api("/api/auth", { method: "DELETE" });
    router.replace("/login");
    router.refresh();
  }
  return (
    <div className="min-h-screen lg:flex">
      <aside className="lg:fixed lg:inset-y-0 lg:w-60 bg-white border-b lg:border-r border-[#e0e5e0] flex flex-col">
        <Link href="/app" className="flex items-center gap-2.5 px-7 pt-7 pb-6">
          <Hexagon className="text-accent" size={26} />
          <span className="font-bold tracking-[.2em] text-xl">KERN</span>
        </Link>
        <p className="hidden lg:block px-7 mb-5 text-[10px] tracking-widest muted">
          PERSONAL WORKSPACE
        </p>
        <nav className="flex lg:flex-col overflow-x-auto px-3 gap-1 pb-3">
          {nav.map(([key, label, Icon]) => (
            <Link
              key={key}
              href={key === "home" ? "/app" : `/app/${key}`}
              className={`flex items-center gap-3 rounded-md px-4 py-3 text-sm whitespace-nowrap ${key === section ? "bg-[#eaf1ed] text-accent font-semibold" : "text-[#6a786f] hover:bg-[#f5f7f4]"}`}
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="hidden lg:block mt-auto p-6">
          <div className="border-t border-[#e8ece8] pt-5 text-xs muted leading-relaxed">
            Ruang pribadi Anda
            <br />
            <span className="text-[#315843]">Asia/Jakarta · IDR</span>
          </div>
          <button
            className="mt-4 text-xs flex items-center gap-2"
            onClick={logout}
          >
            <LogOut size={14} />
            Keluar
          </button>
        </div>
      </aside>
      <main className="lg:ml-60 flex-1 min-w-0">
        <header className="h-16 border-b border-[#e0e5e0] flex justify-between items-center px-6 lg:px-10 text-xs muted">
          <span>
            Ruang pribadi / <span className="text-[#263e31]">{title}</span>
          </span>
          <span className="hidden sm:inline">
            {DateTime.now()
              .setZone("Asia/Jakarta")
              .setLocale("id")
              .toFormat("cccc, dd LLL yyyy")}
          </span>
          <button
            className="lg:hidden flex items-center gap-1"
            onClick={logout}
          >
            <LogOut size={14} />
            Keluar
          </button>
        </header>
        <div className="p-6 lg:p-10 max-w-[1440px] mx-auto">
          <div className="flex flex-wrap gap-4 justify-between items-start mb-8">
            <div>
              <p className="text-[10px] tracking-[.18em] text-accent font-semibold mb-2">
                {section === "home"
                  ? "HARI INI, LEBIH JELAS"
                  : "KERN / CATATAN PRIBADI"}
              </p>
              <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
              <p className="text-sm muted mt-2">{descriptions[section]}</p>
            </div>
            <div className="flex gap-2">
              <button
                className="btn"
                title="Muat ulang data"
                onClick={() => setReload((v) => v + 1)}
              >
                <RefreshCw size={15} />
                <span className="hidden sm:inline">Muat ulang</span>
              </button>
              {!["home", "settings"].includes(section) && (
                <button
                  className="btn btn-primary"
                  onClick={() => setEditor(null)}
                >
                  <Plus size={16} />
                  Tambah
                </button>
              )}
            </div>
          </div>
          {section === "home" ? (
            <Overview key={reload} />
          ) : section === "settings" ? (
            <Settings key={reload} />
          ) : (
            <Records
              key={`${section}:${reload}`}
              section={section}
              edit={setEditor}
            />
          )}
          <footer className="mt-10 pt-5 border-t border-[#e0e5e0] text-[11px] muted flex justify-between gap-4">
            <span>KERN · Your Personal Intelligence System.</span>
            <span>Hanya data yang dicatat.</span>
          </footer>
        </div>
      </main>
      {editor !== undefined && (
        <Editor
          section={section}
          row={editor}
          close={() => setEditor(undefined)}
          saved={() => {
            setEditor(undefined);
            setReload((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
function Empty({
  children = "Belum ada catatan. Tambahkan melalui Telegram atau tombol Tambah.",
}: {
  children?: React.ReactNode;
}) {
  return <p className="muted text-sm p-7 leading-relaxed">{children}</p>;
}
function ErrorBox({ error }: { error: string }) {
  return (
    <div
      role="alert"
      className="panel p-5 text-sm text-red-800 flex items-start gap-3"
    >
      <CircleAlert size={18} />
      <span>{error}</span>
    </div>
  );
}
function useData<T>(url: string) {
  const [state, setState] = useState<{
    url: string;
    data: T | null;
    error: string;
  }>({ url, data: null, error: "" });
  useEffect(() => {
    let live = true;
    api<T>(url)
      .then((d) => {
        if (live) setState({ url, data: d, error: "" });
      })
      .catch((e) => {
        if (live) setState({ url, data: null, error: e.message });
      });
    return () => {
      live = false;
    };
  }, [url]);
  return state.url === url ? state : { data: null, error: "" };
}
function Overview() {
  const { data, error } = useData<DashboardData>("/api/dashboard");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty>Memuat ringkasan…</Empty>;
  return (
    <>
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-7">
        {[
          [
            "Pengeluaran bulan ini",
            money(data.month.expense),
            `Hari ini ${money(data.day.expense)}`,
          ],
          [
            "Pemasukan bulan ini",
            money(data.month.income),
            `${data.month.count} transaksi tercatat`,
          ],
          [
            "Selisih pemasukan − pengeluaran",
            money(data.month.balance),
            "Transfer tidak dihitung",
          ],
          [
            "Task lewat tenggat",
            String(data.overdue),
            "Task terbuka yang perlu ditinjau",
          ],
        ].map(([label, value, note]) => (
          <div key={label} className="panel p-5">
            <p className="text-xs muted mb-4">{label}</p>
            <p className="text-2xl font-semibold tracking-tight">{value}</p>
            <p className="text-[11px] muted mt-3">{note}</p>
          </div>
        ))}
      </div>
      <div className="grid xl:grid-cols-[1.6fr_1fr] gap-6">
        <div className="space-y-6">
          <Panel title="Fokus hari ini" href="/app/tasks">
            {data.tasks.length ? (
              data.tasks.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 px-5 py-4 border-t border-[#edf0ed]"
                >
                  <CheckSquare size={17} className="muted" />
                  <span className="text-sm flex-1">
                    {t.title}
                    <small className="block muted mt-1">
                      {t.dueAt ? date(t.dueAt) : "Tanpa tenggat"}
                    </small>
                  </span>
                  <span className="badge">P{t.priority}</span>
                </div>
              ))
            ) : (
              <Empty>Belum ada task untuk hari ini.</Empty>
            )}
          </Panel>
          <Panel title="Transaksi terakhir" href="/app/transactions">
            <div className="overflow-x-auto">
              {data.transactions.length ? (
                <table className="w-full">
                  <thead>
                    <tr>
                      <th>Deskripsi</th>
                      <th>Kategori</th>
                      <th>Nominal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.transactions.map((t) => (
                      <tr key={t.id}>
                        <td>
                          {t.description}
                          <small className="block muted mt-1">
                            {date(t.occurredAt)} · {t.status}
                          </small>
                        </td>
                        <td>
                          <span className="badge">{t.category}</span>
                        </td>
                        <td className="whitespace-nowrap font-medium">
                          {t.type === "expense"
                            ? "− "
                            : t.type === "income"
                              ? "+ "
                              : "↔ "}
                          {money(t.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty />
              )}
            </div>
          </Panel>
          <Panel title="Pengeluaran per kategori">
            {Object.entries(data.month.categories).length ? (
              Object.entries(data.month.categories).map(([category, value]) => (
                <div
                  key={category}
                  className="flex justify-between px-5 py-3 text-sm"
                >
                  <span>{category}</span>
                  <span>{money(value)}</span>
                </div>
              ))
            ) : (
              <Empty>Belum ada pengeluaran bulan ini.</Empty>
            )}
            <p className="px-5 pb-5 text-xs muted">
              {data.previousMonth.count
                ? `Bulan sebelumnya: ${money(data.previousMonth.expense)} pengeluaran tercatat.`
                : "Perbandingan belum tersedia: bulan sebelumnya belum memiliki catatan."}
            </p>
          </Panel>
        </div>
        <div className="space-y-6">
          <Panel title="Pengingat berikutnya" href="/app/reminders">
            {data.reminders.length ? (
              data.reminders.map((r) => (
                <div key={r.id} className="px-5 py-4 border-t border-[#edf0ed]">
                  <p className="text-sm">{r.title}</p>
                  <p className="text-xs muted mt-2">
                    {date(r.nextRunAt)} · {r.recurrence}
                  </p>
                </div>
              ))
            ) : (
              <Empty>Belum ada pengingat aktif.</Empty>
            )}
          </Panel>
          <Panel title="Anggaran bulan ini" href="/app/budgets">
            {data.budgets.length ? (
              data.budgets.map((b) => (
                <div key={b.id} className="px-5 py-4">
                  <div className="text-sm flex justify-between">
                    <span>{b.category}</span>
                    <span className={b.warning ? "text-amber-700" : "muted"}>
                      {b.percent}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-[#eef1ed] rounded mt-3">
                    <div
                      className={`h-full rounded ${b.warning ? "bg-amber-600" : "bg-accent"}`}
                      style={{ width: `${Math.min(100, Number(b.percent))}%` }}
                    />
                  </div>
                  <p className="text-xs muted mt-2">
                    {money(b.spent)} dari {money(b.amount)}
                  </p>
                </div>
              ))
            ) : (
              <Empty>Atur anggaran untuk memantau batas pengeluaran.</Empty>
            )}
          </Panel>
          <Panel title="Catatan terbaru" href="/app/notes">
            {data.notes.length ? (
              data.notes.map((n) => (
                <div key={n.id} className="px-5 py-4 border-t border-[#edf0ed]">
                  <p className="text-sm">{n.title}</p>
                  <p className="text-xs muted mt-2 line-clamp-2">{n.content}</p>
                </div>
              ))
            ) : (
              <Empty />
            )}
          </Panel>
          <Panel title="Status antrean" href="/app/settings">
            <div className="p-5 text-xs space-y-3">
              <p>
                Sheets:{" "}
                {data.sync.map((s) => `${s._count} ${s.status}`).join(" · ") ||
                  "Belum ada pekerjaan"}
              </p>
              <p>
                Telegram:{" "}
                {data.jobs.map((s) => `${s._count} ${s.status}`).join(" · ") ||
                  "Belum ada pekerjaan"}
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
function Panel({
  title,
  href,
  children,
}: {
  title: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <div className="p-5 flex justify-between items-center">
        <h2 className="text-sm font-semibold">{title}</h2>
        {href && (
          <Link
            href={href}
            className="text-xs text-accent flex items-center gap-1"
          >
            Lihat semua
            <ArrowUpRight size={13} />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
function Records({
  section,
  edit,
}: {
  section: string;
  edit: (row: Row) => void;
}) {
  const [query, setQuery] = useState(""),
    [params, setParams] = useState(""),
    [page, setPage] = useState(1);
  const { data, error } = useData<{ rows: Row[]; count?: number }>(
    `/api/${section}?page=${page}${params}`,
  );
  const columns: Record<string, [string, string][]> = {
    transactions: [
      ["description", "Transaksi"],
      ["occurredAt", "Tanggal"],
      ["type", "Jenis"],
      ["category", "Kategori"],
      ["amount", "Nominal"],
      ["status", "Status"],
    ],
    tasks: [
      ["title", "Task"],
      ["priority", "Prioritas"],
      ["dueAt", "Tenggat"],
      ["status", "Status"],
    ],
    reminders: [
      ["title", "Pengingat"],
      ["scheduledAt", "Jadwal"],
      ["recurrence", "Pengulangan"],
      ["nextRunAt", "Berikutnya"],
      ["status", "Jadwal"],
      ["deliveryStatus", "Pengiriman"],
    ],
    notes: [
      ["title", "Judul"],
      ["tags", "Tag"],
      ["category", "Kategori"],
      ["updatedAt", "Diperbarui"],
    ],
    budgets: [
      ["category", "Kategori"],
      ["month", "Bulan"],
      ["amount", "Anggaran"],
      ["spent", "Terpakai"],
      ["percent", "%"],
      ["warningPercent", "Peringatan %"],
    ],
  };
  return (
    <>
      <form
        className="flex flex-wrap gap-3 mb-5"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const p = new URLSearchParams();
          for (const [k, v] of form)
            if (v) {
              if (k === "from" || k === "to")
                p.set(
                  k,
                  DateTime.fromISO(String(v), { zone: "Asia/Jakarta" })
                    .toUTC()
                    .toISO()!,
                );
              else p.set(k, String(v));
            }
          setParams("&" + p.toString());
          setPage(1);
        }}
      >
        <div className="flex-1 min-w-48 relative">
          <Search className="absolute left-3 top-3 text-[#88958c]" size={16} />
          <input
            className="pl-9"
            name="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari catatan…"
            aria-label="Cari catatan"
          />
        </div>
        {section === "transactions" && (
          <>
            <select
              className="!w-auto"
              name="type"
              aria-label="Jenis transaksi"
            >
              <option value="">Semua jenis</option>
              <option value="expense">Pengeluaran</option>
              <option value="income">Pemasukan</option>
              <option value="transfer">Transfer</option>
            </select>
            <input
              className="!w-36"
              name="category"
              placeholder="Kategori"
              aria-label="Kategori"
            />
            <input
              className="!w-40"
              type="date"
              name="from"
              aria-label="Dari tanggal (inklusif)"
            />
            <input
              className="!w-40"
              type="date"
              name="to"
              aria-label="Sampai tanggal (eksklusif)"
            />
            <input
              className="!w-44"
              name="accountId"
              placeholder="ID akun"
              aria-label="Filter ID akun"
            />
          </>
        )}
        {["tasks", "notes", "reminders"].includes(section) && (
          <select className="!w-auto" name="status" aria-label="Filter status">
            <option value="all">Semua</option>
            <option value={section === "tasks" ? "open" : "active"}>
              Aktif
            </option>
            {section === "tasks" && (
              <>
                <option value="overdue">Lewat tenggat</option>
                <option value="completed">Selesai</option>
                <option value="in_progress">Dikerjakan</option>
              </>
            )}
            {section === "notes" ? (
              <option value="archived">Diarsipkan</option>
            ) : (
              <option value="cancelled">Dibatalkan</option>
            )}
          </select>
        )}
        {section === "notes" && (
          <>
            <input
              className="!w-36"
              name="tag"
              placeholder="Tag"
              aria-label="Tag"
            />
            <input
              className="!w-36"
              name="category"
              placeholder="Kategori"
              aria-label="Kategori"
            />
          </>
        )}
        <button className="btn">Terapkan</button>
      </form>
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Empty>Memuat data…</Empty>
      ) : (
        <div className="panel overflow-x-auto">
          {data.rows.length ? (
            <table className="w-full">
              <thead>
                <tr>
                  {columns[section].map(([key, label]) => (
                    <th key={key}>{label}</th>
                  ))}
                  <th>Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    {columns[section].map(([key]) => (
                      <td
                        key={key}
                        className={
                          ["amount", "spent"].includes(key)
                            ? "whitespace-nowrap font-medium"
                            : ""
                        }
                      >
                        {["amount", "spent"].includes(key) ? (
                          money(row[key])
                        ) : key.endsWith("At") ? (
                          date(row[key])
                        ) : ["status", "deliveryStatus", "category"].includes(
                            key,
                          ) ? (
                          <span className="badge">{text(row[key])}</span>
                        ) : (
                          text(row[key])
                        )}
                        {key === "title" &&
                          section === "reminders" &&
                          Boolean(row.lastError) && (
                            <small className="block text-red-700 mt-1">
                              {text(row.lastError)}
                            </small>
                          )}
                      </td>
                    ))}
                    <td>
                      <button
                        className="text-accent text-xs font-semibold whitespace-nowrap"
                        onClick={() => edit(row)}
                      >
                        Lihat / ubah
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty />
          )}
        </div>
      )}
      {data && (
        <div className="flex justify-between items-center text-xs muted mt-4">
          <span>
            {data.count ?? data.rows.length} catatan
            {section === "budgets" ? " bulan ini" : ` · Halaman ${page}`}
          </span>
          {data.count !== undefined && (
            <div className="flex gap-2">
              <button
                className="btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Sebelumnya
              </button>
              <button
                className="btn"
                disabled={page * 50 >= data.count}
                onClick={() => setPage((p) => p + 1)}
              >
                Berikutnya
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
type Field = {
  name: string;
  label: string;
  type?: string;
  options?: string[];
  required?: boolean;
  initial?: string;
};
const commonTitle: Field = { name: "title", label: "Judul", required: true };
const fields: Record<string, Field[]> = {
  transactions: [
    {
      name: "type",
      label: "Jenis",
      options: ["expense", "income", "transfer"],
    },
    { name: "amount", label: "Nominal rupiah bulat", required: true },
    { name: "description", label: "Deskripsi / merchant", required: true },
    {
      name: "occurredAt",
      label: "Tanggal dan waktu (WIB)",
      type: "datetime-local",
      required: true,
    },
    { name: "category", label: "Kategori", initial: "other", required: true },
    { name: "paymentMethod", label: "Pembayaran (QRIS, tunai, …)" },
    { name: "accountId", label: "Akun asal", options: [] },
    { name: "toAccountId", label: "Akun tujuan (transfer)", options: [] },
  ],
  tasks: [
    commonTitle,
    { name: "description", label: "Deskripsi", type: "textarea" },
    {
      name: "priority",
      label: "Prioritas (1 tertinggi)",
      options: ["1", "2", "3"],
      initial: "2",
    },
    {
      name: "status",
      label: "Status",
      options: ["open", "in_progress", "completed", "cancelled"],
    },
    { name: "dueAt", label: "Tenggat (WIB)", type: "datetime-local" },
    { name: "project", label: "Proyek" },
  ],
  reminders: [
    commonTitle,
    { name: "message", label: "Pesan tambahan", type: "textarea" },
    {
      name: "scheduledAt",
      label: "Jadwal baru (WIB)",
      type: "datetime-local",
      required: true,
    },
    {
      name: "recurrence",
      label: "Pengulangan",
      options: ["once", "daily", "weekly", "monthly"],
    },
    {
      name: "status",
      label: "Status jadwal",
      options: ["active", "cancelled"],
    },
  ],
  notes: [
    commonTitle,
    { name: "content", label: "Isi catatan", type: "textarea", required: true },
    { name: "tags", label: "Tag (pisahkan dengan koma)" },
    { name: "category", label: "Kategori", initial: "general", required: true },
    { name: "project", label: "Proyek" },
    { name: "archived", label: "Diarsipkan", options: ["false", "true"] },
  ],
  budgets: [
    { name: "month", label: "Bulan", type: "month", required: true },
    {
      name: "category",
      label: "Kategori (sama dengan transaksi)",
      required: true,
    },
    { name: "amount", label: "Batas rupiah bulat", required: true },
    {
      name: "warningPercent",
      label: "Ambang peringatan (%)",
      type: "number",
      initial: "80",
    },
  ],
};
function Editor({
  section,
  row,
  close,
  saved,
}: {
  section: string;
  row: Row | null;
  close: () => void;
  saved: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [accounts, setAccounts] = useState<Row[]>([]),
    [accountName, setAccountName] = useState("");
  useEffect(() => {
    if (section === "transactions")
      api<{ rows: Row[] }>("/api/accounts")
        .then((d) => setAccounts(d.rows))
        .catch((e) => setError(e.message));
  }, [section]);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, textarea, [tabindex="0"]',
        ) || [],
      );
    focusable()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const elements = focusable(),
          first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [close]);
  function initial(field: Field) {
    const value = row?.[field.name];
    if (value !== undefined && value !== null) {
      if (field.type === "datetime-local")
        return DateTime.fromISO(String(value))
          .setZone("Asia/Jakarta")
          .toFormat("yyyy-MM-dd'T'HH:mm");
      return Array.isArray(value) ? value.join(", ") : String(value);
    }
    if (field.name === "occurredAt")
      return DateTime.now()
        .setZone("Asia/Jakarta")
        .toFormat("yyyy-MM-dd'T'HH:mm");
    if (field.name === "month")
      return DateTime.now().setZone("Asia/Jakarta").toFormat("yyyy-MM");
    return field.initial || field.options?.[0] || "";
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data: Record<string, unknown> = Object.fromEntries(
      new FormData(event.currentTarget),
    );
    for (const field of fields[section]) {
      if (field.type === "datetime-local")
        data[field.name] = data[field.name]
          ? DateTime.fromISO(String(data[field.name]), { zone: "Asia/Jakarta" })
              .toUTC()
              .toISO()
          : null;
      else if (["priority", "warningPercent"].includes(field.name))
        data[field.name] = Number(data[field.name]);
      else if (field.name === "tags")
        data.tags = String(data.tags || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      else if (field.name === "archived")
        data.archived = data.archived === "true";
      else if (data[field.name] === "") data[field.name] = null;
    }
    if (section === "reminders") data.timezone = "Asia/Jakarta";
    if (
      (row || section === "budgets") &&
      !window.confirm(
        "Simpan perubahan berikut?\n\n" +
          fields[section]
            .map((f) => `${f.label}: ${text(data[f.name])}`)
            .join("\n"),
      )
    )
      return;
    if (row || section === "budgets") data.confirmed = true;
    if (row) data.expectedUpdatedAt = row.updatedAt;
    setBusy(true);
    try {
      await api(
        `/api/${section}${row && section !== "budgets" ? `/${row.id}` : ""}`,
        {
          method: row && section !== "budgets" ? "PATCH" : "POST",
          body: JSON.stringify(data),
        },
      );
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function voidRow() {
    if (
      !row ||
      !window.confirm(
        `Batalkan transaksi ${row.id}? Transaksi ini tidak lagi dihitung dalam laporan. Riwayat tetap tersimpan.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api(`/api/transactions/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          action: "void",
          confirmed: true,
          expectedUpdatedAt: row.updatedAt,
        }),
      });
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="fixed inset-0 bg-black/25 z-50 flex items-start justify-center p-4 overflow-y-auto"
      role="presentation"
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
        className="panel w-full max-w-xl my-8 p-6 shadow-lg"
      >
        <div className="flex justify-between items-center mb-5">
          <h2 id="editor-title" className="text-xl font-semibold">
            {row ? "Detail / ubah" : "Tambah"}{" "}
            {nav.find((n) => n[0] === section)?.[1].toLowerCase()}
          </h2>
          <button className="btn" aria-label="Tutup" onClick={close}>
            <X size={16} />
          </button>
        </div>
        {row && (
          <p className="text-xs muted mb-5 break-all">
            ID: {row.id}
            {section === "reminders" &&
              ` · Pengiriman: ${text(row.deliveryStatus)} · ${text(row.lastError)}`}
          </p>
        )}
        <form onSubmit={submit} className="space-y-4">
          {fields[section].map((field) => (
            <label key={field.name}>
              <span>
                {field.label}
                {field.required ? " *" : ""}
              </span>
              {field.type === "textarea" ? (
                <textarea
                  name={field.name}
                  defaultValue={initial(field)}
                  required={field.required}
                  rows={5}
                />
              ) : field.options ? (
                <select
                  name={field.name}
                  aria-label={field.label}
                  defaultValue={initial(field)}
                >
                  {field.name.endsWith("AccountId") ||
                  field.name === "accountId" ? (
                    <>
                      <option value="">Tanpa akun</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {text(a.name)}
                        </option>
                      ))}
                    </>
                  ) : (
                    field.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))
                  )}
                </select>
              ) : (
                <input
                  name={field.name}
                  type={field.type || "text"}
                  defaultValue={initial(field)}
                  required={field.required}
                  min={field.type === "number" ? 1 : undefined}
                  max={field.type === "number" ? 100 : undefined}
                />
              )}
            </label>
          ))}
          {section === "reminders" && row && (
            <p className="text-xs muted">
              Untuk menjadwalkan ulang atau mengaktifkan kembali, pilih waktu di
              masa depan. Pesan yang sudah mulai dikirim mungkin tetap diterima.
            </p>
          )}
          {error && (
            <p className="text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-3">
            <button
              className="btn btn-primary"
              disabled={busy || row?.status === "void"}
            >
              Simpan
            </button>
            <button type="button" className="btn" onClick={close}>
              Tutup
            </button>
            {section === "transactions" && row?.status === "active" && (
              <button
                type="button"
                disabled={busy}
                className="btn !text-red-700 ml-auto"
                onClick={voidRow}
              >
                Batalkan transaksi
              </button>
            )}
          </div>
        </form>
        {section === "transactions" && (
          <div className="mt-6 pt-5 border-t border-[#e0e5e0]">
            <label>
              <span>Tambah akun (opsional)</span>
              <input
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder="Contoh: BCA, Tunai"
              />
            </label>
            <button
              className="btn mt-2"
              disabled={!accountName.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/api/accounts", {
                    method: "POST",
                    body: JSON.stringify({ name: accountName }),
                  });
                  setAccounts(
                    (await api<{ rows: Row[] }>("/api/accounts")).rows,
                  );
                  setAccountName("");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Buat akun
            </button>
            <p className="text-xs muted mt-2">
              {accounts.map((a) => `${a.name}: ${a.id}`).join(" · ")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
function Settings() {
  const [version, setVersion] = useState(0),
    [error, setError] = useState("");
  const { data, error: loadError } = useData<HealthData>(
    `/api/health?page=${version + 1}`,
  );
  const retry = useCallback(
    async (resource: string, row: { id: string; status: string }) => {
      if (
        !window.confirm(
          row.status === "uncertain"
            ? "Periksa chat Telegram terlebih dahulu. Kirim ulang meskipun ada risiko pesan duplikat?"
            : "Antrekan ulang pekerjaan ini setelah konfigurasi diperbaiki?",
        )
      )
        return;
      try {
        await api(`/api/${resource}/${encodeURIComponent(row.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            confirmed: true,
            acknowledgeDuplicateRisk: row.status === "uncertain",
          }),
        });
        setVersion((v) => v + 1);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );
  if (loadError) return <ErrorBox error={loadError} />;
  if (!data) return <Empty>Memeriksa koneksi database…</Empty>;
  return (
    <div className="space-y-6">
      {error && <ErrorBox error={error} />}
      <div className="panel p-6">
        <h2 className="font-semibold text-sm mb-4">Status konfigurasi</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {[["Database", true], ...Object.entries(data.integrations)].map(
            ([key, configured]) => (
              <div
                key={String(key)}
                className="flex justify-between border-b border-[#edf0ed] pb-3 text-sm"
              >
                <span className="capitalize">{String(key)}</span>
                <span className="badge">
                  {key === "Database"
                    ? "Terhubung"
                    : key === "scheduler"
                      ? configured
                        ? "Berjalan"
                        : data.schedulerLastRunAt
                          ? `Terhenti sejak ${new Date(data.schedulerLastRunAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`
                          : "Belum pernah berjalan"
                      : typeof configured === "string"
                        ? `Terkonfigurasi (${configured})`
                        : configured
                          ? "Terkonfigurasi"
                          : "Belum diatur"}
                </span>
              </div>
            ),
          )}
        </div>
        <p className="text-xs muted mt-5">
          {data.note} Atur kredensial melalui environment server. Tidak ada
          secret yang ditampilkan di sini.
        </p>
      </div>
      {(
        [
          ["jobs", "Pengiriman Telegram", data.jobs],
          ["sync", "Sinkronisasi Google Sheets", data.sync],
          ["inbox", "Pemrosesan pesan masuk", data.inbox],
        ] as const
      ).map(([resource, label, rows]) => (
        <Panel key={resource} title={label}>
          <div className="overflow-x-auto">
            {rows.length ? (
              <table className="w-full">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Status</th>
                    <th>Percobaan</th>
                    <th>Keterangan</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="text-xs max-w-48 break-all">{r.id}</td>
                      <td>
                        <span className="badge">{r.status}</span>
                      </td>
                      <td>{r.attempts}</td>
                      <td>{r.lastError || "—"}</td>
                      <td>
                        {[
                          "failed",
                          "blocked",
                          "uncertain",
                          ...(resource === "sync" ? ["retry"] : []),
                        ].includes(r.status) && (
                          <button
                            className="btn"
                            onClick={() => retry(resource, r)}
                          >
                            Coba ulang
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>Tidak ada pekerjaan yang perlu diperiksa.</Empty>
            )}
          </div>
        </Panel>
      ))}
      <p className="text-xs muted">
        accepted = diterima server Telegram (Bot API tidak menyediakan tanda
        terkirim/dibaca). uncertain memerlukan pemeriksaan manual sebelum
        mencoba ulang.
      </p>
    </div>
  );
}
