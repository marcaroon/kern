# Panduan memasang KERN sendiri

Panduan ini untuk kamu yang ingin punya KERN sendiri: bot Telegram pribadi untuk mencatat keuangan, tugas, pengingat, dan catatan. Setiap orang memasang salinannya sendiri, jadi **datamu hanya ada di akunmu**. Pemilik repo asli tidak bisa melihatnya.

- **Biaya:** gratis (semua memakai paket gratis).
- **Waktu:** sekitar 45 menit, cukup sekali.
- **Yang dibutuhkan:** laptop/PC dengan browser dan akun Telegram. Tidak perlu menginstal apa pun.
- **Hasil akhir:** bot Telegram yang selalu online, dashboard web pribadi, pengingat, dan laporan harian/mingguan.

> Simpan semua kunci/token di catatan pribadi (misalnya password manager). **Jangan kirim kunci ke siapa pun**, termasuk ke grup chat.

---

## Langkah 1 — Buat akun yang diperlukan

Daftar (gratis) di:

1. **GitHub**: https://github.com/signup
2. **Vercel**: https://vercel.com/signup, pilih **Continue with GitHub**
3. **Supabase**: https://supabase.com/dashboard/sign-up
4. **Google AI Studio** (untuk AI): https://aistudio.google.com, cukup login dengan akun Google
5. **cron-job.org** (penjadwal): https://console.cron-job.org/signup

## Langkah 2 — Siapkan database (Supabase)

1. Di Supabase, klik **New project**.
   - Name: `kern`
   - **Database password:** buat password **hanya huruf dan angka** (tanpa simbol, supaya tidak bermasalah di alamat koneksi). Simpan password ini.
   - Region: **Southeast Asia (Singapore)**
2. Tunggu project selesai dibuat, lalu klik tombol **Connect** di bagian atas.
   - Salin connection string **Transaction pooler** (port **6543**). Ganti `[YOUR-PASSWORD]` dengan password database. Ini nilai **`DATABASE_URL`**.
   - Salin connection string **Session pooler** (port **5432**), ganti password juga. Ini nilai **`DIRECT_URL`**.
3. Buka **Project Settings → Database → SSL Configuration → Download certificate**. Buka file yang terunduh dengan Notepad, lalu salin **seluruh isinya** (dari `-----BEGIN CERTIFICATE-----` sampai `-----END CERTIFICATE-----`). Ini nilai **`DATABASE_CA_CERT`**.
4. Buka **Project Settings → API** (atau **API Keys**). Salin:
   - **Project URL** → **`NEXT_PUBLIC_SUPABASE_URL`**
   - **anon / publishable key** → **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** (jangan pakai _service_role_ / _secret key_)
5. Buat akun login dashboard: **Authentication → Users → Add user → Create new user**. Isi email dan password, centang **Auto Confirm User**. Setelah dibuat, klik user tersebut dan salin **User UID**. Ini nilai **`KERN_OWNER_SUPABASE_USER_ID`**.
6. Matikan pendaftaran publik: **Authentication → Sign In / Providers**, lalu nonaktifkan **Allow new users to sign up**.

## Langkah 3 — Buat bot Telegram

1. Di Telegram, buka **@BotFather** dan kirim `/newbot`.
2. Beri nama (misal "KERN Budi") dan username yang berakhiran `bot` (misal `kern_budi_bot`).
3. Salin token yang diberikan. Ini nilai **`TELEGRAM_BOT_TOKEN`**. Token ini seperti password: siapa pun yang memilikinya bisa mengendalikan bot.

## Langkah 4 — Buat kunci AI (Gemini)

1. Buka https://aistudio.google.com/apikey lalu klik **Create API key**.
2. Salin kuncinya. Ini nilai **`GEMINI_API_KEY`**.
3. Untuk **`GEMINI_MODEL`**, isi `gemini-3.5-flash-lite`.

> **Privasi:** di paket gratis, Google boleh memakai isi pesan yang dikirim ke AI (termasuk pesan keuanganmu) untuk meningkatkan produknya. Kalau kamu tidak mau, aktifkan billing di project Google tersebut; biayanya sangat kecil untuk pemakaian pribadi. Tanpa kunci AI pun bot tetap jalan, hanya memahami pola perintah baku.

## Langkah 5 — Buat dua kode rahasia

Buat **dua** teks acak, masing-masing **40 karakter, hanya huruf dan angka**. Kamu bisa memakai generator password (Google Password Manager, Bitwarden, dll.).

- Kode pertama → **`KERN_INTERNAL_API_SECRET`** (untuk penjadwal)
- Kode kedua → **`TELEGRAM_WEBHOOK_SECRET`** (untuk Telegram)

## Langkah 6 — Salin kode KERN dan deploy ke Vercel

1. Buka https://github.com/marcaroon/kern lalu klik **Fork → Create fork**. Sekarang kamu punya salinan di akun GitHub-mu.
2. Di Vercel, klik **Add New… → Project**, lalu pilih repo `kern` milikmu → **Import**.
3. Buka bagian **Environment Variables** dan tambahkan satu per satu:

   | Nama                            | Nilai                           |
   | ------------------------------- | ------------------------------- |
   | `DATABASE_URL`                  | dari Langkah 2.2 (port 6543)    |
   | `DIRECT_URL`                    | dari Langkah 2.2 (port 5432)    |
   | `DATABASE_CA_CERT`              | isi sertifikat dari Langkah 2.3 |
   | `NEXT_PUBLIC_SUPABASE_URL`      | dari Langkah 2.4                |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | dari Langkah 2.4                |
   | `KERN_OWNER_SUPABASE_USER_ID`   | dari Langkah 2.5                |
   | `TELEGRAM_BOT_TOKEN`            | dari Langkah 3                  |
   | `GEMINI_API_KEY`                | dari Langkah 4                  |
   | `GEMINI_MODEL`                  | `gemini-3.5-flash-lite`         |
   | `KERN_INTERNAL_API_SECRET`      | kode rahasia pertama            |
   | `TELEGRAM_WEBHOOK_SECRET`       | kode rahasia kedua              |

4. Klik **Deploy**. Build berjalan beberapa menit. Tabel database dibuat otomatis selama build.
5. Setelah selesai, salin alamat situsmu, misalnya `https://kern-budi.vercel.app`. Alamat ini disebut **DOMAIN** di langkah berikutnya.

## Langkah 7 — Hubungkan bot ke situsmu

1. Susun alamat berikut di Notepad. Ganti `TOKEN`, `DOMAIN`, dan `RAHASIA` (nilai `TELEGRAM_WEBHOOK_SECRET`):

   ```
   https://api.telegram.org/botTOKEN/setWebhook?url=DOMAIN/api/webhooks/telegram&secret_token=RAHASIA&allowed_updates=%5B%22message%22%5D
   ```

   Contoh bagian awalnya: `https://api.telegram.org/bot123456:ABC.../setWebhook?url=https://kern-budi.vercel.app/api/webhooks/telegram&...`

2. Tempel alamat itu di browser lalu tekan Enter. Kalau berhasil, akan muncul `{"ok":true,"result":true,"description":"Webhook was set"}`.
3. Buka bot-mu di Telegram dan kirim `/start`. Bot akan membalas: **"KERN belum dikonfigurasi. ID Telegram kamu: 123456789"**.
4. Di Vercel, buka project → **Settings → Environment Variables**, lalu tambahkan **`TELEGRAM_OWNER_USER_ID`** dengan angka ID tadi.
5. Buka **Deployments**, klik **⋯** pada deployment teratas, lalu pilih **Redeploy**.

Setelah ini bot hanya melayani kamu; pesan dari orang lain diabaikan.

## Langkah 8 — Pasang penjadwal (cron-job.org)

Penjadwal menjalankan pengingat, laporan harian (07:00 WIB) dan mingguan (Minggu 20:00), serta perawatan data. Cukup **satu** job.

1. Di cron-job.org, klik **Create cronjob**.
   - **URL:** `DOMAIN/api/internal/tick`
   - **Schedule:** setiap **1 menit**
2. Tab **Advanced**:
   - **Request method:** `POST`
   - **Headers → Add:** key `Authorization`, value `Bearer ` (dengan spasi) diikuti `KERN_INTERNAL_API_SECRET`
3. Simpan. Tunggu satu menit lalu cek riwayatnya: harus **200 OK**. Kalau **401**, berarti isi header salah.

Penjadwal ini juga menjaga database Supabase tetap aktif. Project gratis Supabase akan dijeda kalau tidak dipakai selama seminggu.

## Langkah 9 — Coba

1. Kirim ke bot: **Catat pengeluaran 35 ribu buat makan siang QRIS**. Bot akan membalas dengan Rp35.000 dan sebuah ID.
2. Coba kalimat bebas: **tadi beli bensin 50rb pakai gopay**.
3. Buka `DOMAIN/login`, lalu masuk dengan email dan password dari Langkah 2.5 untuk melihat dashboard.

Kirim `bantuan` ke bot untuk melihat contoh perintah.

## Opsional — Google Sheets

Kalau ingin salinan transaksi otomatis di Google Sheets, ikuti [SETUP_GOOGLE_SHEETS.md](SETUP_GOOGLE_SHEETS.md). Setelah itu tambahkan `GOOGLE_SHEETS_SPREADSHEET_ID` dan `GOOGLE_SERVICE_ACCOUNT_JSON` di Vercel, lalu Redeploy. Isi spreadsheet tetap **Restricted** (jangan "Anyone with the link"), karena berisi data keuanganmu.

## Memperbarui ke versi terbaru

Buka repo `kern` milikmu di GitHub lalu klik **Sync fork → Update branch**. Vercel akan deploy ulang otomatis dan menjalankan perubahan database bila ada.

## Kalau ada masalah

| Gejala                                                | Penyebab dan solusi                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot tidak membalas sama sekali                        | Cek webhook: buka `https://api.telegram.org/botTOKEN/getWebhookInfo`. `url` harus berisi domainmu, dan lihat `last_error_message`. Ulangi Langkah 7. |
| Bot membalas "KERN belum dikonfigurasi" terus         | `TELEGRAM_OWNER_USER_ID` belum diisi atau belum Redeploy (Langkah 7.4–7.5).                                                                          |
| Bot membalas "Belum bisa memahami pesan ini tanpa AI" | Kunci atau model Gemini salah, atau kuota gratis sedang habis. Pola baku tetap jalan.                                                                |
| Build gagal di Vercel                                 | Biasanya `DATABASE_URL`, `DIRECT_URL`, atau `DATABASE_CA_CERT` salah. Pastikan password sudah diganti dan sertifikat tersalin utuh.                  |
| Pengingat atau laporan tidak datang                   | Cek riwayat job di cron-job.org (harus 200).                                                                                                         |
| Tidak bisa login dashboard                            | Pastikan user dibuat dengan **Auto Confirm** dan UID-nya sama dengan `KERN_OWNER_SUPABASE_USER_ID`.                                                  |

Paket gratis Vercel (Hobby) hanya untuk pemakaian pribadi non-komersial.
