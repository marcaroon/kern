# Supabase and local setup

## Configured workspace

The dedicated `kern` project is provisioned in Singapore on the Free plan. All Prisma migrations have been deployed. The local `.env` points to its session pooler on port 5432, and the owner Auth user is configured. No application records were seeded.

Open `http://localhost:3000/login`. Initial login details are in the Git-ignored `.local/KERN_LOGIN.txt`; save the password in your password manager. The local connection uses `sslmode=verify-full` with `.local/supabase-ca.crt`, downloaded from Supabase's official certificate endpoint. Both certificate and hostname verification were tested. Database SSL enforcement is enabled. When moving hosts, install the CA there and update the absolute `sslrootcert` path in both database URLs; do not disable certificate verification.

Public signups and anonymous Auth are disabled. All 14 application tables have RLS without client policies; `anon` and `authenticated` also have no privileges on `_prisma_migrations`. Only the server database connection accesses application tables. See VERIFICATION.md for live checks and remaining limits.

## Setting up another environment

1. Create a Supabase project. Keep database password and connection strings server-only. Copy PostgreSQL connection settings into DATABASE_URL (runtime) and DIRECT_URL (migrations). Use the direct connection or session pooler for migrations; use the appropriate pooler and port for your network. TLS is required for hosted connections. Prisma 7 uses `@prisma/adapter-pg`; CLI reads DIRECT_URL from prisma.config.ts.
2. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to the project's public URL and anon/publishable key. Never use a service-role key in a NEXT_PUBLIC variable.
3. Create one email/password user via Supabase Auth administration, verify the email, and set KERN_OWNER_SUPABASE_USER_ID to that user's UUID. Disable public signups if unnecessary. No signup route or authentication bypass is included in KERN.
4. Set NEXT_PUBLIC_APP_URL to the exact public origin (http://localhost:3000 locally, HTTPS in production). Cookie-authenticated mutations reject other origins. Set Auth Site URL accordingly.
5. Run `npm ci`, `npm run db:generate`, `npm run db:migrate`, `npm run dev`. Visit `/login`, sign in, then create a task. Restart after changing environment settings. The proxy refreshes auth cookies; every data endpoint independently calls getUser and checks ownership.
6. Sign in as a different test user and verify access is denied. Verify unauthenticated `/api/transactions` does not return records. Application tables have RLS enabled and no client policies; keep credentials with bypass/table-owner access server-side only. Avoid enabling public policies for these tables.

Prisma migrations use the migration history, not db push. Back up before production migrations. `db:dev` requires a disposable development/shadow database and is not a production command. The bundled PGlite tests exercise SQL without external accounts; they do not replace running migrations against the actual Supabase instance.

Safe demo seeding is optional: create an isolated database whose name contains `demo`, point both database URLs at it, configure a test Auth owner, set KERN_ALLOW_DEMO_SEED=true and NODE_ENV=development, then run `npm run db:seed`. Only clearly labelled tasks/notes are added; no financial rows or outbound jobs are generated. Do not turn an existing personal database into a demo database.

Official references: [Supabase server-side authentication](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Prisma PostgreSQL driver and connection setup](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql).
