-- 202609150001_mfa_and_password_reset tried to add "requestedIp" via
-- CREATE TABLE IF NOT EXISTS "PasswordResetToken", but that migration ran
-- *after* 202609150001_admin_mfa_password_recovery already created the
-- table (without requestedIp) — so IF NOT EXISTS silently no-op'd and the
-- column was never added, even though schema.prisma and
-- src/services/passwordResetService.js both expect it. This adds it.

ALTER TABLE "PasswordResetToken"
  ADD COLUMN IF NOT EXISTS "requestedIp" TEXT;
