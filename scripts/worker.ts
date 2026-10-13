import "dotenv/config";
import { db } from "../src/lib/db";
import { automate } from "../src/services/automation";
import { safeCode } from "../src/lib/errors";
const database = db();
let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});
console.log(
  "KERN local worker: processes real configured data. Stop with Ctrl+C.",
);
while (!stopped) {
  for (const operation of ["dispatch", "sheets", "maintenance"]) {
    try {
      await automate(database, operation);
    } catch (error) {
      console.error(JSON.stringify({ operation, code: safeCode(error) }));
    }
    if (stopped) break;
  }
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, 5000));
}
await database.$disconnect();
