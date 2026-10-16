-- Savings goals. Contributions move money aside; they are not income or expense.
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" BIGINT NOT NULL,
    "saved" BIGINT NOT NULL DEFAULT 0,
    "deadline" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "achievedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Goal_amount_check" CHECK ("target" > 0 AND "saved" >= 0)
);
CREATE INDEX "Goal_ownerId_status_idx" ON "Goal"("ownerId", "status");
ALTER TABLE "Goal" ENABLE ROW LEVEL SECURITY;

-- Daily habits with a local check-in time (HH:mm) and one log per local day.
CREATE TABLE "Habit" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "checkinTime" TEXT NOT NULL DEFAULT '20:00',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Habit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Habit_checkinTime_check" CHECK ("checkinTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
CREATE INDEX "Habit_ownerId_status_idx" ON "Habit"("ownerId", "status");
ALTER TABLE "Habit" ENABLE ROW LEVEL SECURITY;

CREATE TABLE "HabitLog" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "habitId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HabitLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HabitLog_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "Habit"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HabitLog_habitId_day_key" ON "HabitLog"("habitId", "day");
CREATE INDEX "HabitLog_ownerId_day_idx" ON "HabitLog"("ownerId", "day");
ALTER TABLE "HabitLog" ENABLE ROW LEVEL SECURITY;

-- Note embeddings for meaning-based search, tagged with the model that made them.
ALTER TABLE "Note" ADD COLUMN "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[];
ALTER TABLE "Note" ADD COLUMN "embeddingModel" TEXT;
