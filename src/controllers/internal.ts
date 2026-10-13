import { boundary, respond } from "@/lib/errors";
import { assertInternal } from "@/lib/security";
import { db } from "@/lib/db";
import { automate } from "@/services/automation";
export function internal(
  request: Request,
  context: { params: Promise<{ operation: string }> },
) {
  return boundary(async () => {
    assertInternal(
      request.headers.get("authorization"),
      process.env.KERN_INTERNAL_API_SECRET,
    );
    return respond(await automate(db(), (await context.params).operation));
  });
}
