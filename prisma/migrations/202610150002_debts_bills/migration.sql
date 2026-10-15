-- Money people owe the owner (owed_to_me) or the owner owes them (i_owe).
CREATE TABLE "Debt" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "person" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "paid" BIGINT NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "nextNudgeAt" TIMESTAMPTZ(3),
    "nudges" INTEGER NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Debt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Debt_direction_check" CHECK ("direction" IN ('owed_to_me', 'i_owe')),
    CONSTRAINT "Debt_amount_check" CHECK ("amount" > 0 AND "paid" >= 0 AND "paid" <= "amount")
);
CREATE INDEX "Debt_ownerId_status_idx" ON "Debt"("ownerId", "status");
CREATE INDEX "Debt_status_nextNudgeAt_idx" ON "Debt"("status", "nextNudgeAt");
ALTER TABLE "Debt" ENABLE ROW LEVEL SECURITY;

-- Monthly recurring bills; nextDueAt is 09:00 local time on the due day.
CREATE TABLE "Bill" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" BIGINT,
    "category" TEXT NOT NULL DEFAULT 'bills',
    "paymentMethod" TEXT,
    "dueDay" INTEGER NOT NULL,
    "nextDueAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastPaidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Bill_dueDay_check" CHECK ("dueDay" BETWEEN 1 AND 31),
    CONSTRAINT "Bill_amount_check" CHECK ("amount" IS NULL OR "amount" > 0)
);
CREATE INDEX "Bill_ownerId_status_idx" ON "Bill"("ownerId", "status");
CREATE INDEX "Bill_status_nextDueAt_idx" ON "Bill"("status", "nextDueAt");
ALTER TABLE "Bill" ENABLE ROW LEVEL SECURITY;
