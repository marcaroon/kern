import { z } from "zod";
import { boundary, respond, AppError } from "@/lib/errors";
import { assertOrigin, bodyJson, rateLimit } from "@/lib/security";
import { supabaseServer } from "@/lib/auth";
export function POST(request: Request) {
  return boundary(async () => {
    assertOrigin(request);
    rateLimit("login", 10);
    const body = z
      .object({ email: z.email(), password: z.string().min(1).max(256) })
      .strict()
      .parse(await bodyJson(request));
    const client = await supabaseServer();
    const { data, error } = await client.auth.signInWithPassword(body);
    if (error || data.user?.id !== process.env.KERN_OWNER_SUPABASE_USER_ID) {
      await client.auth.signOut();
      throw new AppError(
        "LOGIN_FAILED",
        401,
        "Login gagal. Periksa akun pemilik dan kata sandi.",
      );
    }
    return respond({ signedIn: true });
  });
}
export function DELETE(request: Request) {
  return boundary(async () => {
    assertOrigin(request);
    const client = await supabaseServer();
    await client.auth.signOut();
    return respond({ signedOut: true });
  });
}
