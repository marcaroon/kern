import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "KERN — Personal Intelligence System",
  description: "Ruang pribadi untuk catatan, keuangan, dan agenda.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
