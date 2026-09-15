-- OPTIONAL CLEANUP — not required to fix the login/password-reset bugs.
-- Review before running: this DROPS objects and data.
--
-- 202609150001_admin_mfa_password_recovery and 202609150001_mfa_and_password_reset
-- were two competing implementations of MFA backup codes. The array-column
-- design (User.mfaBackupCodes) is the one in schema.prisma and in use by
-- src/routes/auth.js. The separate-table design from
-- admin_mfa_password_recovery (MfaBackupCode, MfaChallenge, User.mfaConfirmedAt)
-- was never wired into the app and isn't in schema.prisma — it's dead
-- weight in the database. This migration removes it.
--
-- Before running: confirm MfaBackupCode / MfaChallenge are genuinely empty
-- or contain nothing you need, e.g.:
--   SELECT count(*) FROM "MfaBackupCode";
--   SELECT count(*) FROM "MfaChallenge";

DROP TABLE IF EXISTS "MfaChallenge";
DROP TABLE IF EXISTS "MfaBackupCode";

ALTER TABLE "User"
  DROP COLUMN IF EXISTS "mfaConfirmedAt";
