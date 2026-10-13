import { Login } from "@/components/login";
export const dynamic = "force-dynamic";
export default function Page() {
  const configured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.KERN_OWNER_SUPABASE_USER_ID,
  );
  return <Login configured={configured} />;
}
