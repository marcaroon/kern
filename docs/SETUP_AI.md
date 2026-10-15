# AI interpretation

KERN supports four interchangeable providers. Configure one or more on the server:

- **Groq**: GROQ_API_KEY and GROQ_MODEL (use `openai/gpt-oss-20b`, a strict JSON Schema model). Set AI_PROVIDER=groq on the Next.js server and worker. The key must never use a NEXT_PUBLIC_ prefix.

- **OpenAI**: OPENAI_API_KEY and OPENAI_MODEL (a model supporting the Responses API and Structured Outputs).
- **Anthropic**: ANTHROPIC_API_KEY and ANTHROPIC_MODEL (a Claude model supporting structured outputs, e.g. `claude-opus-5-5`). API usage is prepaid Console credit; a Claude Pro chat subscription does not include it.
- **Google Gemini**: GEMINI_API_KEY (from Google AI Studio) and GEMINI_MODEL (a model supporting JSON-schema output, e.g. a Gemini 3 Flash ID). **Privacy:** on the free tier Google may use prompts and responses, which here include your financial messages, to improve its products, and human reviewers may read them. Enabling billing on the key's Google Cloud project moves it to the paid tier, which excludes that use. Free-tier rate limits apply; a 429 falls back to the deterministic patterns.

AI_PROVIDER=`groq`, `openai`, `anthropic` or `gemini` selects one explicitly. An explicitly selected provider that is not fully configured disables AI (deterministic fallback) rather than silently switching vendors. When AI_PROVIDER is empty, the first configured of Groq, OpenAI, Anthropic and Gemini is used. The Integrasi page shows which provider is active. No paid requests are made by tests or setup. No key is required for the narrow deterministic fallback.

OpenAI uses the official SDK's `responses.parse` and `zodTextFormat` with `store:false`. Anthropic uses the official `@anthropic-ai/sdk` `messages.parse` with `zodOutputFormat` and low effort; any stop reason other than `end_turn` (refusal, truncation) is treated as unusable output. Gemini uses the official `@google/genai` SDK with `responseJsonSchema` generated from the same Zod schema, low thinking level and no SDK retries; any finish reason other than `STOP` (safety block, truncation) is unusable output. All results then pass the same Zod and domain validation, including the explicit-IDR amount check. The structured result contains intent, confidence, missing fields, confirmation flag and nullable entities. Each message produces at most one explicit service action; the model cannot run SQL, commands, or HTTP requests. Confidence below 0.8 or missing fields produces clarification. Amounts must also occur explicitly in the user's own messages (the current one or an earlier user turn in the provided history, never a KERN reply), and use integer rupiah. Financial reports and memory retrieval are database operations; the model does not estimate balances or invent saved notes.

The provider receives the current message, date/time instructions and a short conversation history: at most the owner's last six processed messages from the preceding 30 minutes and KERN's replies to them, wrapped in `<riwayat>` and marked as data. This lets the assistant follow up on its own questions ("berapa?" → "45rb"), and resolve "yang tadi" from IDs in earlier replies. Redacted (retention-expired) messages are never included, and no database dump is transmitted. API timeout is 20 seconds, SDK retries are disabled, and unavailable/refusing/invalid outputs fall back safely. The fallback understands clear expense capture, simple `tambah task`, `catat ide/catatan`, explicit tomorrow-morning reminders, expense-period queries, note search, agenda, help, greetings/thanks and simple splits such as `split 300rb bagi 3`. Other requests honestly ask for clarification.

AI-driven creation may save immediately after validation. Mutations with financial/material consequences, and every amount read from a photo, prepare a reviewable, expiring PendingAction. The user answers with a plain `ya` (also `oke`, `sip`, `simpan`, …) or `batal`, matched by a deterministic pattern before any AI call; `konfirmasi UUID` still works. Only one proposal is live per owner: a new one supersedes older ones, so `ya` always refers to the latest question. An AI-supplied confirmation flag cannot consume confirmations. Targets are owner-scoped and version checked; ambiguous matches are not modified.

Test with the provided Indonesian examples, deliberately ambiguous amounts/dates, provider timeout and invalid model output before trusting broader natural language. The fallback tests do not establish a live model's accuracy.

Official references: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output). Live accuracy of either provider on Indonesian KERN messages has not been verified.

## Groq setup and verification

Set these values in your private `.env` and in the hosting environment, then restart/redeploy:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=your-private-key
GROQ_MODEL=openai/gpt-oss-20b
```

Groq uses the existing OpenAI-compatible client at `https://api.groq.com/openai/v1/chat/completions`, strict JSON Schema, a 20-second timeout and no automatic SDK retries. It rejects refusals, truncated output, invalid JSON/schema and invented amounts before executing any action. A missing key/model or failed request uses the narrow deterministic fallback; it does not silently switch to another vendor. Only use a model supporting strict structured output ([Groq documentation](https://console.groq.com/docs/structured-outputs)).

Run `npm run integrations:check` for read-only database connectivity, Groq model availability, Telegram webhook/polling consistency and Sheets header checks. Model availability does not prove inference accuracy. Missing integrations are reported as NOT_CONFIGURED; failed configured checks set a nonzero exit code. The command never sends chat messages or writes spreadsheet cells. Check the selected AI provider on the Integrasi page.

Telegram replies use a warm, casual Indonesian persona (aku/kamu, at most one emoji) defined in the system prompt, with action confirmations based on committed service results. Amounts, IDs and dates are preserved; critical edits still require a `ya` answer. Sheets copies remain explicitly pending until the sync worker verifies them. The webhook processes one queued action and one outbound message per request; keep the scheduler running to drain the backlog. This bounds batch size, not all latency under database contention.

## Receipt photos and split bill

Send a photo (or an image file: JPEG, PNG or WebP, at most 4 MB) of a receipt, bill or payment proof. KERN stores only Telegram's `file_id`, downloads the image into memory when processing, and sends it inline (base64) to the vision model. The Telegram file URL contains the bot token, so it is never passed to a provider, stored or logged. Retention maintenance clears the `file_id` with the message text.

- **Vision model.** `AI_VISION_PROVIDER` (optional) chooses the provider for photos; empty uses `AI_PROVIDER`. The model is `<P>_VISION_MODEL`, defaulting to `<P>_MODEL` for OpenAI, Anthropic and Gemini. Groq's `openai/gpt-oss-*` models are text-only, so Groq requires `GROQ_VISION_MODEL` (Groq's vision docs list `qwen/qwen3.8-27b`; check [the current list](https://console.groq.com/docs/vision)). Groq image requests use non-strict JSON Schema, so the result is validated with Zod like every other provider. Without a vision model KERN replies that photos are not configured; nothing is guessed.
- **What the model does.** It only transcribes: merchant, printed date, line items, tax, service, discount, grand total, payment method and a category suggestion. KERN normalises printed rupiah formats, checks that items plus tax/discount match the total (and warns when they do not, using the printed total), refuses non-IDR receipts, and ignores implausible dates (future or older than a year).
- **Recording.** A photo never saves directly. KERN shows what it read and asks; `ya` records one income/expense with the receipt's date, category and payment method through the normal audited, Sheets-outboxed transaction path. A caption such as "pemasukan" sets the type.
- **Split bill.** A caption with `split`, `patungan`, `bagi`, … or a text follow-up within 30 minutes (`bagi rata 3 orang`, `aku nasi goreng, Budi mie ayam, es teh bareng`) splits the latest receipt. A stated total also works without a photo (`split 300rb bagi 3`). The model only maps items to people; the money is computed deterministically in BIGINT: each person's exact portion of the items (shared items divided equally) weights a single allocation of the printed total, so tax, service and discounts follow each person's portion, shares always sum to the total, and equal portions differ by at most Rp1. `ya` records only the user's own share ("Kamu"). Plain equal splits need no model call.

Vision requests time out after 25 seconds and the split mapping after 15; a failed or unusable answer produces an honest "coba lagi" reply and writes nothing.
