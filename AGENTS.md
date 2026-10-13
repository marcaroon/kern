# KERN project instructions

Act as a rigorous, honest mentor. Challenge flawed assumptions with reasons and a better alternative.

- Preserve user data; never seed production or bypass authentication.
- Keep routes thin; share business rules through services.
- IDR is bigint, serialized as a decimal string. Transfers are excluded from income/expense.
- Every private query is owner scoped. Never log content, tokens, credentials, or raw provider errors.
- Mutations and their audit/outbox writes are atomic. External acceptance is not delivery.
- Test security, retry/idempotency and date/money branches. Run test, lint, typecheck and build.
- Optional providers must degrade honestly. Document all unverified live integrations.
