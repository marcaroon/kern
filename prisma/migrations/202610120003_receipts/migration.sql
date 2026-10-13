CREATE TABLE "DeliveryReceipt" (
  "providerId" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "error" TEXT
);
CREATE INDEX "DeliveryReceipt_ownerId_occurredAt_idx" ON "DeliveryReceipt"("ownerId", "occurredAt");
ALTER TABLE "DeliveryReceipt" ENABLE ROW LEVEL SECURITY;
