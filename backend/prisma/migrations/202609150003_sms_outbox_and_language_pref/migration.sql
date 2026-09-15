-- Step 17: SMS notification outbox (transactional-outbox pattern) and a
-- per-user language preference, laying the groundwork for SMS delivery and
-- localized notification bodies.

DO $$ BEGIN
  CREATE TYPE "SmsOutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "smsNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "preferredLanguage" TEXT NOT NULL DEFAULT 'en';

CREATE TABLE IF NOT EXISTS "SmsOutboxEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" "SmsOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "SmsOutboxEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SmsOutboxEntry_status_createdAt_idx" ON "SmsOutboxEntry"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "SmsOutboxEntry_userId_idx" ON "SmsOutboxEntry"("userId");

DO $$ BEGIN
  ALTER TABLE "SmsOutboxEntry"
    ADD CONSTRAINT "SmsOutboxEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
