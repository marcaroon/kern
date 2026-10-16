import OpenAI, { toFile } from "openai";
import { FinishReason, GoogleGenAI } from "@google/genai";
import { configured, required } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { aiProviders, type AiProvider } from "./ai";

export type Audio = { data: Buffer; mime: string };
type Target = { provider: AiProvider; model: string };
// Spoken amounts as digits keep the "amount must be stated" guard working.
const hint =
  "Transkrip pesan suara berbahasa Indonesia untuk aplikasi pencatat. Tulis angka dan nominal dengan digit, misalnya 50 ribu, 1.500.000, jam 7 malam, tanggal 5.";

// AI_TRANSCRIBE_PROVIDER lists providers in order; empty follows AI_PROVIDER.
// Groq and OpenAI need <P>_TRANSCRIBE_MODEL (Whisper-style); Gemini defaults to its
// chat model, which accepts audio. Anthropic has no audio input.
export function transcribeTargets(): Target[] {
  const listed = (process.env.AI_TRANSCRIBE_PROVIDER || "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const chain = (listed.length ? listed : aiProviders()) as string[];
  const targets: Target[] = [];
  for (const name of chain) {
    const model =
      name === "groq" && configured("GROQ_API_KEY")
        ? process.env.GROQ_TRANSCRIBE_MODEL
        : name === "openai" && configured("OPENAI_API_KEY")
          ? process.env.OPENAI_TRANSCRIBE_MODEL
          : name === "gemini" && configured("GEMINI_API_KEY", "GEMINI_MODEL")
            ? process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL
            : undefined;
    if (model && !targets.some((t) => t.provider === name))
      targets.push({ provider: name as AiProvider, model });
  }
  return targets;
}
const extension = (mime: string) =>
  ({
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/aac": "aac",
    "audio/opus": "ogg",
  })[mime] || "ogg";
async function viaWhisper(target: Target, audio: Audio) {
  const client = new OpenAI({
    apiKey: required(
      target.provider === "groq" ? "GROQ_API_KEY" : "OPENAI_API_KEY",
    ),
    ...(target.provider === "groq"
      ? { baseURL: "https://api.groq.com/openai/v1" }
      : {}),
    timeout: 25000,
    maxRetries: 0,
  });
  const result = await client.audio.transcriptions.create({
    file: await toFile(audio.data, `voice.${extension(audio.mime)}`, {
      type: audio.mime,
    }),
    model: target.model,
    language: "id",
    prompt: hint,
    response_format: "json",
  });
  return result.text;
}
async function viaGemini(target: Target, audio: Audio) {
  const client = new GoogleGenAI({
    apiKey: required("GEMINI_API_KEY"),
    httpOptions: { timeout: 25000, retryOptions: { attempts: 1 } },
  });
  const result = await client.models.generateContent({
    model: target.model,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: audio.mime,
              data: audio.data.toString("base64"),
            },
          },
          {
            text: `${hint} Keluarkan hanya transkripnya, tanpa komentar. Jika tidak ada ucapan, keluarkan teks kosong.`,
          },
        ],
      },
    ],
  });
  if (result.candidates?.[0]?.finishReason !== FinishReason.STOP)
    throw new Error("AI_UNUSABLE_OUTPUT");
  return result.text ?? "";
}
// The spoken text, or an AppError with a friendly message. Audio is never stored.
export async function transcribe(audio: Audio): Promise<string> {
  const targets = transcribeTargets();
  if (!targets.length)
    throw new AppError(
      "TRANSCRIBE_NOT_CONFIGURED",
      503,
      "Aku belum bisa mendengarkan voice note karena layanan transkripsi belum diatur (GROQ_TRANSCRIBE_MODEL atau Gemini). Ketik saja pesannya dulu, ya.",
    );
  let limited = false;
  for (const target of targets) {
    try {
      const text = (
        target.provider === "gemini"
          ? await viaGemini(target, audio)
          : await viaWhisper(target, audio)
      )
        .replace(/\s+/g, " ")
        .trim();
      return text.slice(0, 2000);
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      limited ||= status === 429;
      // Provider and status code only, never the provider message.
      console.error(
        JSON.stringify({
          event: "transcribe_failed",
          provider: target.provider,
          status: typeof status === "number" ? status : null,
        }),
      );
    }
  }
  throw new AppError(
    limited ? "TRANSCRIBE_RATE_LIMITED" : "TRANSCRIBE_UNAVAILABLE",
    503,
    limited
      ? "Layanan transkripsi lagi kena batas pemakaian per menit. Coba kirim ulang voice note-nya sekitar 1 menit lagi, ya."
      : "Maaf, aku lagi gagal mendengarkan voice note-nya. Coba kirim ulang, atau ketik saja pesannya.",
  );
}
