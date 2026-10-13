import { handleApi } from "@/controllers/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export { handleApi as GET, handleApi as POST, handleApi as PATCH };
