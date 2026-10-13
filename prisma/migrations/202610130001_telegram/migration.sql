-- Telegram replaces WhatsApp as the only messaging channel.
ALTER TABLE "InboxMessage" RENAME COLUMN "phone" TO "sender";
UPDATE "Job" SET "kind" = 'message' WHERE "kind" = 'whatsapp';
-- WhatsApp-only state: the 24-hour service window and Meta delivery receipts.
DROP TABLE "Contact";
DROP TABLE "DeliveryReceipt";
