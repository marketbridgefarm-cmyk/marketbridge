-- Profile photo: stores the private object-storage key. Nullable, so existing users are unaffected.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarKey" TEXT;
