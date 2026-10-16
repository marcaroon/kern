import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { Database, Tx } from "@/lib/db";
import { configured, required } from "@/lib/config";

// Short vectors keep the per-owner scan cheap; a few thousand notes fit in memory.
export const dimensions = 256;
// gemini-embedding-001 scores unrelated Indonesian notes around 0.67-0.77 and
// related ones 0.75-0.85 (6 live samples, 16 Oct 2026), so a match needs a high
// score and must be close to the best one.
export const minScore = 0.74;
export const maxGap = 0.04;
export type EmbeddingTarget = { provider: "gemini" | "openai"; model: string };

// Gemini or OpenAI, whichever has an embedding model configured (Gemini first).
export function embeddingTarget(): EmbeddingTarget | null {
  if (configured("GEMINI_API_KEY", "GEMINI_EMBEDDING_MODEL"))
    return { provider: "gemini", model: required("GEMINI_EMBEDDING_MODEL") };
  if (configured("OPENAI_API_KEY", "OPENAI_EMBEDDING_MODEL"))
    return { provider: "openai", model: required("OPENAI_EMBEDDING_MODEL") };
  return null;
}
// Stored tag: vectors from different models or sizes are never compared.
export const modelTag = (t: EmbeddingTarget) =>
  `${t.provider}:${t.model}:${dimensions}`;

function normalize(vector: number[]) {
  const length = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return length ? vector.map((v) => v / length) : vector;
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
export async function embed(
  texts: string[],
  kind: "document" | "query",
  target: EmbeddingTarget,
): Promise<number[][]> {
  let vectors: number[][];
  if (target.provider === "gemini") {
    const client = new GoogleGenAI({
      apiKey: required("GEMINI_API_KEY"),
      httpOptions: { timeout: 15000, retryOptions: { attempts: 1 } },
    });
    const result = await client.models.embedContent({
      model: target.model,
      contents: texts,
      config: {
        taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        outputDimensionality: dimensions,
      },
    });
    vectors = (result.embeddings ?? []).map((e) => e.values ?? []);
  } else {
    const client = new OpenAI({
      apiKey: required("OPENAI_API_KEY"),
      timeout: 15000,
      maxRetries: 0,
    });
    const result = await client.embeddings.create({
      model: target.model,
      input: texts,
      dimensions,
    });
    vectors = result.data.map((d) => d.embedding);
  }
  if (
    vectors.length !== texts.length ||
    vectors.some((v) => v.length !== dimensions)
  )
    throw new Error("EMBEDDING_UNUSABLE_OUTPUT");
  return vectors.map(normalize);
}
const noteText = (n: { title: string; content: string; tags: string[] }) =>
  `${n.title}\n${n.content}${n.tags.length ? `\n#${n.tags.join(" #")}` : ""}`.slice(
    0,
    4000,
  );
// Scheduled backfill: new or edited notes get a vector within a minute or so.
export type Embedder = (
  texts: string[],
  kind: "document" | "query",
  target: EmbeddingTarget,
) => Promise<number[][]>;
export async function embedPendingNotes(
  database: Database,
  limit = 20,
  embedder: Embedder = embed,
) {
  const target = embeddingTarget();
  if (!target) return { embedded: 0, configured: false };
  const tag = modelTag(target);
  const notes = await database.note.findMany({
    where: {
      archived: false,
      OR: [{ embeddingModel: null }, { embeddingModel: { not: tag } }],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      content: true,
      tags: true,
      updatedAt: true,
    },
  });
  if (!notes.length) return { embedded: 0, configured: true };
  let vectors: number[][];
  try {
    vectors = await embedder(notes.map(noteText), "document", target);
  } catch (error) {
    // Status code only: never the provider message or note content.
    const status = (error as { status?: unknown })?.status;
    console.error(
      JSON.stringify({
        event: "embedding_failed",
        provider: target.provider,
        status: typeof status === "number" ? status : null,
      }),
    );
    return { embedded: 0, configured: true, failed: true };
  }
  let embedded = 0;
  for (const [i, note] of notes.entries()) {
    // Skip notes edited meanwhile; the next run embeds their new text.
    const result = await database.note.updateMany({
      where: { id: note.id, updatedAt: note.updatedAt },
      data: { embedding: vectors[i], embeddingModel: tag },
    });
    embedded += result.count;
  }
  return { embedded, configured: true };
}
// Notes closest in meaning to the query; empty when embeddings are unavailable.
export async function similarNotes(
  tx: Tx,
  ownerId: string,
  query: string,
  limit = 5,
  embedder: Embedder = embed,
) {
  const target = embeddingTarget();
  if (!target || !query.trim()) return [];
  let vector: number[];
  try {
    [vector] = await embedder([query.slice(0, 1000)], "query", target);
  } catch {
    return [];
  }
  const notes = await tx.note.findMany({
    where: { ownerId, archived: false, embeddingModel: modelTag(target) },
    select: { id: true, title: true, content: true, embedding: true },
  });
  return notes
    .map((n) => ({ ...n, score: cosine(vector, n.embedding) }))
    .filter((n) => n.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .filter((n, _, all) => n.score >= all[0].score - maxGap)
    .slice(0, limit);
}
