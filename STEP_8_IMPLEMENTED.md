# MarketBridge — Step 8: Admin MFA + Password Recovery

Implements roadmap priority **#6** from the evaluation report (`MFA_Evaluation_and_Enhancement_Recommendations`).

## Implemented

### Admin two-factor authentication (TOTP primary, email fallback)
- `POST /api/auth/mfa/setup/start` (admin, authenticated) — generates a TOTP secret, encrypted at rest (AES-256-GCM), returns a QR code + manual-entry secret. MFA stays *off* until confirmed.
- `POST /api/auth/mfa/setup/confirm` — verifies a live code, flips `mfaEnabled = true`, issues 10 one-time backup codes (shown once, bcrypt-hashed thereafter).
- `POST /api/auth/mfa/disable` / `POST /api/auth/mfa/backup-codes/regenerate` — both require the current password as a step-up check.
- Login flow: `POST /api/auth/login` now returns `{ mfaRequired: true, challengeId, methods }` instead of a session when an admin account has MFA enabled. No token or refresh cookie is issued until the challenge is completed.
- `POST /api/auth/mfa/challenge/email` — sends a 6-digit email OTP for the challenge (fallback factor).
- `POST /api/auth/mfa/verify` — accepts a TOTP code, email OTP, or backup code against a challenge; issues the session identically to a normal login on success. Capped at 5 attempts per challenge.

### Password recovery
- `POST /api/auth/password/forgot` — always returns the same generic message (no account enumeration). Emails a 30-minute reset link if the account exists.
- `POST /api/auth/password/reset` — validates the token, updates the password, and **revokes every active refresh session** for that account (forces re-login everywhere — important if the reset was triggered by a credential leak).

### Supporting changes
- New Prisma models: `MfaBackupCode`, `MfaChallenge`, `PasswordResetToken`; new `User` fields `mfaEnabled` / `mfaSecret` / `mfaConfirmedAt`.
- New tight rate limiters (`mfaLimiter`: 10/15min, `passwordResetLimiter`: 5/15min) for brute-force protection, per the report's security recommendations.
- New env vars required in production (added to `index.js` `validateEnv()`, so the server now refuses to boot without them):
  - `MFA_ENCRYPTION_KEY` — 32 bytes, base64 or 64-char hex. Generate with `openssl rand -base64 32`.
  - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — any SMTP provider (SES, SendGrid, Mailgun, etc.).
  - Outside production, a missing SMTP config logs the email to the console instead of failing, so local dev needs no real mail credentials.
- Frontend: `Login.jsx` gets a code-entry step; new pages `ForgotPassword.jsx`, `ResetPassword.jsx`, `AdminSecuritySettings.jsx` (QR setup, backup codes, disable — reachable via a "Security" link on the Admin Control Center, kept as its own page rather than another tab since `AdminDashboard.jsx` is already flagged for the roadmap's #10 refactor).

## Files added
- `backend/prisma/migrations/202609150001_admin_mfa_password_recovery/migration.sql`
- `backend/src/utils/mfaCrypto.js`
- `backend/src/utils/mfa.js`
- `backend/src/utils/mailer.js`
- `frontend/src/pages/ForgotPassword.jsx`
- `frontend/src/pages/ResetPassword.jsx`
- `frontend/src/pages/AdminSecuritySettings.jsx`

## Files changed
- `backend/prisma/schema.prisma`
- `backend/src/routes/auth.js`
- `backend/src/middleware/rateLimit.js`
- `backend/src/index.js`
- `backend/package.json` (added `otplib`, `qrcode`, `nodemailer`)
- `frontend/src/context/AuthContext.jsx`
- `frontend/src/pages/Login.jsx`
- `frontend/src/App.jsx`
- `frontend/src/pages/AdminDashboard.jsx` (one link added)
- `frontend/src/styles.css` (`.btn-danger`, `.btn-link`)

## To deploy
1. Generate and set the new env vars above on Render (backend) — the server will refuse to start in production without them.
2. Push these files, run `npx prisma migrate deploy` (or let CI/deploy do it) — no other config needed.
3. No existing accounts are affected: `mfaEnabled` defaults to `false`, so every current admin keeps logging in exactly as before until they opt in from **Admin Control Center → Security**.

## Validation
All modified/added backend JavaScript files pass `node --check`. Dependencies (`otplib`, `qrcode`, `nodemailer`) are not installed in this extraction environment, so a dependency-backed test run (`npm ci && npm test`) still needs to happen in CI/staging before this goes to production — same caveat as prior steps.

## Not yet done
Everything else from the report's Top 10 remains open: CSP hardening (#7), Ethiopian geography/transport matching (#8), Amharic/Afaan Oromo + SMS (#9), and the route/dashboard refactor + API docs (#10). Recommend #7 (CSP) next — `helmet({ contentSecurityPolicy: false })` in `index.js` means there's currently no CSP at all in production.
