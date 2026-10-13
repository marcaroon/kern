import "dotenv/config";
import { googleSheet, sheetHeaders } from "../src/integrations/sheets";
const sheet = googleSheet();
const existing = await sheet.read("Transactions!A1:L1");
if (
  existing.length &&
  JSON.stringify(existing[0]) !== JSON.stringify(sheetHeaders)
)
  throw new Error(
    "Non-matching headers: refusing to overwrite existing data. Create an empty Transactions worksheet.",
  );
await sheet.write("Transactions!A1:L1", [sheetHeaders]);
if (
  JSON.stringify((await sheet.read("Transactions!A1:L1"))[0]) !==
  JSON.stringify(sheetHeaders)
)
  throw new Error("Header verification failed");
console.log("Transactions worksheet headers verified.");
