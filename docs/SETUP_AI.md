# AI interpretation

KERN supports two interchangeable providers. Configure either or both on the server:

- **OpenAI**: OPENAI_API_KEY and OPENAI_MODEL (a model supporting the Responses API and Structured Outputs).
- **Anthropic**: ANTHROPIC_API_KEY and ANTHROPIC_MODEL (a Claude model supporting structured outputs, e.g. `claude-opus-5-5`).

AI_PROVIDER=`openai` or `anthropic` selects one explicitly. An explicitly selected provider that is not fully configured disables AI (deterministic fallback) rather than silently switching vendors. When AI_PROVIDER is empty, OpenAI is used if configured, otherwise Anthropic. The Integrasi page shows which provider is active. No paid requests are made by tests or setup. No key is required for the narrow deterministic fallback.

OpenAI uses the official SDK's `responses.parse` and `zodTextFormat` with `store:false`. Anthropic uses the official `@anthropic-ai/sdk` `messages.parse` with `zodOutputFormat` and low effort; any stop reason other than `end_turn` (refusal, truncation) is treated as unusable output. Both results then pass the same Zod and domain validation. The structured result contains intent, confidence, missing fields, confirmation flag and nullable entities. Each message produces at most one explicit service action; the model cannot run SQL, commands, or HTTP requests. Confidence below 0.8 or missing fields produces clarification. Amounts must also occur explicitly in the current input, and use integer rupiah. Financial reports and memory retrieval are database operations; the model does not estimate balances or invent saved notes.

Only current text and date/time instructions are sent to the provider. No full history or database dump is transmitted. API timeout is 20 seconds, SDK retries are disabled, and unavailable/refusing/invalid outputs fall back safely. The fallback understands clear expense capture, simple `tambah task`, `catat ide/catatan`, explicit tomorrow-morning reminders, expense-period queries, note search, agenda and help. Other requests honestly ask for clarification. Resend a full corrected request; context merging across follow-up fragments is not implemented.

AI-driven creation may save immediately after validation. Mutations with financial/material consequences prepare a reviewable, expiring PendingAction. The user must send the exact deterministic `konfirmasi UUID` message; an AI-supplied confirmation flag cannot consume confirmations. Targets are owner-scoped and version checked; ambiguous matches are not modified.

Test with the provided Indonesian examples, deliberately ambiguous amounts/dates, provider timeout and invalid model output before trusting broader natural language. The fallback tests do not establish a live model's accuracy.

Official references: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Live accuracy of either provider on Indonesian KERN messages has not been verified.
