"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ShieldCheck, Hexagon } from "lucide-react";
export function Login({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error.message);
      router.replace("/app");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login gagal. Coba lagi.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <section className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-10">
          <Hexagon className="text-accent" size={28} />
          <span className="text-xl font-bold tracking-[.18em]">KERN</span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Ruang untuk hidup
          <br />
          yang lebih teratur.
        </h1>
        <p className="muted mt-3 mb-8 leading-relaxed">
          Catatan, keuangan, dan agenda.
          <br />
          Your Personal Intelligence System.
        </p>
        <div className="panel p-7">
          <div className="flex items-center gap-2 text-sm font-semibold mb-6">
            <ShieldCheck size={18} className="text-accent" /> Akses pribadi
            pemilik
          </div>
          {!configured ? (
            <div className="text-sm leading-relaxed">
              <p>Konfigurasi Supabase belum lengkap.</p>
              <p className="muted mt-3">
                Isi URL Supabase, public key, dan ID pemilik di{" "}
                <code>.env</code>, lalu restart aplikasi. Panduan tersedia di{" "}
                <code>docs/SETUP_SUPABASE.md</code>.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <label>
                <span>Email</span>
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                <span>Kata sandi</span>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
              <button disabled={busy} className="btn btn-primary w-full">
                {busy ? "Memverifikasi…" : "Masuk ke KERN"}
                <ArrowRight size={16} />
              </button>
            </form>
          )}
        </div>
        <p className="muted text-xs mt-5">
          Data pribadi hanya tersedia setelah identitas pemilik diverifikasi.
        </p>
      </section>
    </main>
  );
}
