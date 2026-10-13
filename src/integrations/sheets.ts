import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { configured, required } from "@/lib/config";
import { AppError } from "@/lib/errors";
import type { Transaction } from "@/generated/prisma/client";

export const sheetHeaders = [
  "transaction_id",
  "transaction_date",
  "type",
  "amount_idr",
  "category",
  "description",
  "payment_method",
  "account",
  "status",
  "created_at",
  "updated_at",
  "to_account",
];
export function sheetValues(
  row: Transaction & {
    account?: { name: string } | null;
    toAccount?: { name: string } | null;
  },
): string[] {
  return [
    row.id,
    row.occurredAt.toISOString(),
    row.type,
    row.amount.toString(),
    row.category,
    row.description,
    row.paymentMethod || "",
    row.account?.name || "",
    row.status,
    row.createdAt.toISOString(),
    row.updatedAt.toISOString(),
    row.toAccount?.name || "",
  ];
}
export interface SheetPort {
  read(range: string): Promise<string[][]>;
  write(range: string, values: string[][]): Promise<void>;
}
export function googleSheet(): SheetPort {
  if (
    !configured("GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON")
  )
    throw new AppError("SHEETS_NOT_CONFIGURED", 503);
  const credentials = z
    .object({ client_email: z.email(), private_key: z.string().min(1) })
    .parse(JSON.parse(required("GOOGLE_SERVICE_ACCOUNT_JSON")));
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(required("GOOGLE_SHEETS_SPREADSHEET_ID"))}/values/`;
  return {
    async read(range) {
      const client = await auth.getClient();
      const response = await client.request<{ values?: string[][] }>({
        url: base + encodeURIComponent(range),
        timeout: 15000,
        retry: false,
      });
      return (response.data.values || []).map((row) => row.map(String));
    },
    async write(range, values) {
      const client = await auth.getClient();
      await client.request({
        url: base + encodeURIComponent(range) + "?valueInputOption=RAW",
        method: "PUT",
        data: { range, majorDimension: "ROWS", values },
        timeout: 15000,
        retry: false,
      });
    },
  };
}
export async function upsertSheetRow(
  sheet: SheetPort,
  row: Transaction & {
    account?: { name: string } | null;
    toAccount?: { name: string } | null;
  },
) {
  const headers = (await sheet.read("Transactions!A1:L1"))[0];
  if (JSON.stringify(headers) !== JSON.stringify(sheetHeaders))
    throw new AppError("SHEETS_HEADERS_MISMATCH", 503);
  const ids = await sheet.read("Transactions!A2:A");
  const matches = ids.flatMap((cells, i) =>
    cells[0] === row.id ? [i + 2] : [],
  );
  if (matches.length > 1) throw new AppError("SHEETS_DUPLICATE_ID", 409);
  const reservedRow = row.sheetRow + 1;
  if (matches.length && matches[0] !== reservedRow)
    throw new AppError("SHEETS_ROW_MOVED", 409);
  const range = `Transactions!A${reservedRow}:L${reservedRow}`;
  const existing = (await sheet.read(range))[0];
  if (existing?.[0] && existing[0] !== row.id)
    throw new AppError("SHEETS_ROW_CONFLICT", 409);
  const expected = sheetValues(row);
  await sheet.write(range, [expected]);
  const actual = (await sheet.read(range))[0] || [];
  if (expected.some((value, index) => value !== (actual[index] || "")))
    throw new AppError("SHEETS_VERIFICATION_FAILED", 503);
}
