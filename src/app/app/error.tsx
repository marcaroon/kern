"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="p-10">
      <h1 className="text-xl mb-3">Data belum dapat dimuat.</h1>
      <p className="muted mb-4">
        Periksa koneksi dan konfigurasi layanan, lalu coba kembali.
      </p>
      <button className="btn" onClick={reset}>
        Coba lagi
      </button>
    </main>
  );
}
