-- Telegram image reference (file_id) for receipt photos. The image itself is never stored.
ALTER TABLE "InboxMessage" ADD COLUMN "fileId" TEXT;
ALTER TABLE "InboxMessage" ADD COLUMN "fileMime" TEXT;
