import { ZodError } from "zod";
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
    message = code,
  ) {
    super(message);
  }
}
export function safeCode(error: unknown) {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error && error.message.startsWith("CONFIG_MISSING:"))
    return "CONFIGURATION_REQUIRED";
  return "SERVICE_UNAVAILABLE";
}
export function respond(data: unknown, status = 200) {
  return new Response(
    JSON.stringify({ data }, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
export async function boundary(fn: () => Promise<Response>) {
  try {
    return await fn();
  } catch (error) {
    const validation = error instanceof ZodError;
    const code = validation ? "VALIDATION_ERROR" : safeCode(error);
    if (!validation && !(error instanceof AppError))
      console.error(JSON.stringify({ event: "request_failed", code }));
    return Response.json(
      {
        error: {
          code,
          message:
            error instanceof AppError
              ? error.message
              : validation
                ? "Periksa data yang diisi."
                : "Layanan belum tersedia. Periksa konfigurasi atau coba lagi.",
          ...(validation
            ? {
                fields: error.issues.map((i) => ({
                  path: i.path.join("."),
                  message: i.message,
                })),
              }
            : {}),
        },
      },
      {
        status: validation
          ? 422
          : error instanceof AppError
            ? error.status
            : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
