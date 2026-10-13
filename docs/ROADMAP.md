# Roadmap

## First deployment priorities

1. Provision a staging Supabase project, apply migrations, test owner login and denial to other users.
2. Test the actual Telegram round trip, proactive reminder delivery, a blocked bot (403) and token revocation.
3. Verify a real service-account Sheets write, lost-response retry procedure and reserved-row capacity. Import/activate workflows on the target n8n version and test timezone schedules.
4. Run multi-worker race and crash-recovery tests against real PostgreSQL, restore a backup, add shared edge rate limiting and uptime/failure monitoring.
5. Validate real model accuracy against an Indonesian corpus (amounts, dates, negations and conflicting instructions), tune clarification and add contextual follow-up state with explicit review.

## Next capabilities (not implemented)

- Voice-note transcription and reviewed receipt extraction.
- Google Calendar integration and calendar events in briefings.
- Email-based bills and deadline detection.
- Semantic memory search with embeddings and scoped retrieval.
- Habits, routines, project-level management and cross-project search.
- Advanced budgets, carry-over, financial insights and trend charts.
- ESP32 display/notification integration.
- Export/delete personal data workflow, configurable multi-timezone dashboard, richer mobile interaction.
- Shared distributed rate limiter, notification reconciliation UI and enhanced operational metrics.

No calendar/email/voice/image integration or semantic memory is implied by the current UI. The MVP uses text and deterministic database facts.
