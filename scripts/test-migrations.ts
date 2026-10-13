import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
const pg = await PGlite.create();
const server = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
await server.start();
const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
async function prisma(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/prisma/build/index.js", ...args],
      {
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Prisma exited ${code}`)),
    );
  });
}
try {
  await prisma(["migrate", "deploy"]);
  await prisma(["migrate", "deploy"]);
  await prisma([
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema.prisma",
    "--exit-code",
  ]);
  console.log(
    "PASS: migrations deploy, repeat safely, and match Prisma schema in an isolated embedded PostgreSQL database.",
  );
} finally {
  await server.stop();
  await pg.close();
}
