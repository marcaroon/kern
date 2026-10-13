// Applies pending Prisma migrations during hosted builds (`vercel-build`).
// Prisma CLI reads the CA from a file, so an inline DATABASE_CA_CERT is written to a
// temporary file and certificate + hostname verification stay enabled.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const direct = process.env.DIRECT_URL;
if (!direct) {
  console.log("DIRECT_URL is not set: skipping database migrations.");
  process.exit(0);
}
const url = new URL(direct);
const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
if (ca && !url.searchParams.has("sslrootcert")) {
  const file = join(tmpdir(), "kern-database-ca.crt").replaceAll("\\", "/");
  writeFileSync(file, `${ca}\n`);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", file);
}
const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DIRECT_URL: url.toString() },
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
