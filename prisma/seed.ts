import "dotenv/config";
import { db } from "../src/lib/db";
import { ownerId, required } from "../src/lib/config";
import { saveTask, saveNote } from "../src/services/records";
if (
  process.env.NODE_ENV === "production" ||
  process.env.KERN_ALLOW_DEMO_SEED !== "true" ||
  !new URL(required("DATABASE_URL")).pathname.includes("demo")
)
  throw new Error(
    "Demo seed requires a separate database with demo in its name and KERN_ALLOW_DEMO_SEED=true. Never seed personal production data.",
  );
const database = db();
try {
  await database.$transaction(async (tx) => {
    const owner = ownerId();
    if (
      await tx.task.findFirst({
        where: { ownerId: owner, title: "[DEMO] Tinjau KERN" },
      })
    )
      return;
    await saveTask(tx, owner, { title: "[DEMO] Tinjau KERN", priority: 2 });
    await saveNote(tx, owner, {
      title: "[DEMO] Ide contoh",
      content: "Ini data demonstrasi buatan, bukan catatan pribadi.",
      tags: ["demo"],
    });
  });
  console.log(
    "Clearly labelled demo tasks and notes inserted. No messages sent.",
  );
} finally {
  await database.$disconnect();
}
