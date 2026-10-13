import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { required } from "./config";
import { assertOwner } from "./security";
export async function supabaseServer() {
  const jar = await cookies();
  return createServerClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (values) => {
          try {
            values.forEach(({ name, value, options }) =>
              jar.set(name, value, options),
            );
          } catch {
            /* Server components use the proxy to refresh cookies. */
          }
        },
      },
    },
  );
}
export async function requireOwner() {
  const client = await supabaseServer();
  const { data, error } = await client.auth.getUser();
  return assertOwner(
    error ? undefined : data.user?.id,
    process.env.KERN_OWNER_SUPABASE_USER_ID,
  );
}
