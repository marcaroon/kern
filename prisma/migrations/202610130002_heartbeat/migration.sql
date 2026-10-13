-- Last successful run of each scheduled operation, for monitoring the external cron.
CREATE TABLE "Heartbeat" (
    "name" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Heartbeat_pkey" PRIMARY KEY ("name")
);
ALTER TABLE "Heartbeat" ENABLE ROW LEVEL SECURITY;
