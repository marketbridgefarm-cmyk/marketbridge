# MarketBridge Operations Runbook

Two procedures that can't be verified from the codebase alone and need to
actually be run against the real infrastructure: a backup/restore test, and
secrets rotation. Both are currently unconfirmed — this is the checklist for
doing each safely.

Stack this assumes: Postgres on Railway, API on Render, object storage on
S3-compatible storage (R2), payments via Chapa.

---

## 1. Backup / restore test

The goal isn't "does a backup exist" — it's "have we actually restored one
and confirmed the data is real and complete." An untested backup is a
guess, not a plan.

### Scripts

`backend/scripts/backup-postgres.sh` and `backend/scripts/restore-postgres.sh`
do the actual dump/restore work below — use them instead of ad hoc
`pg_dump`/`pg_restore` commands so the steps below stay in sync with what
the repo actually runs:

```bash
cd backend
DATABASE_URL="..." npm run backup            # dumps, verifies, uploads off-site, prunes old backups
DATABASE_URL="$SCRATCH_DATABASE_URL" CONFIRM_RESTORE=YES npm run restore -- backups/marketbridge-<timestamp>.dump
# or restore straight from off-site storage without a local file:
DATABASE_URL="$SCRATCH_DATABASE_URL" CONFIRM_RESTORE=YES npm run restore -- s3:marketbridge-<timestamp>.dump
npm run backup:list                           # list what's in off-site storage
```

Both scripts require the CLI tools (`pg_dump`/`pg_restore`/`psql`) locally —
`chmod +x scripts/*.sh` once after cloning if they lose their executable
bit (git preserves it once committed with `git update-index --chmod=+x`,
but archives/zip exports typically don't).

`backup-postgres.sh` writes the dump to `backend/backups/` locally *and*
uploads it off-site (S3/R2) if `S3_BACKUP_BUCKET` — or the existing
`S3_BUCKET` — plus `S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`
are set. This matters because Render's filesystem is ephemeral: a backup
that only ever lands on local disk is gone the next time the service
redeploys or restarts, so treat local-only backups as scratch space, not
as the real backup. It also prunes anything (local and off-site) older
than `BACKUP_RETENTION_DAYS` (default 14) so backups don't accumulate
forever. Local dumps are gitignored (`backend/.gitignore`) — never commit
one; a raw dump contains every user's PII and full payment history.

Neither script runs on a schedule by itself — there's no cron/GitHub
Action calling `npm run backup` yet. Until Railway's own automated
backups (below) are confirmed sufficient, or a scheduled job is added to
call `npm run backup` (a Render Cron Job or a scheduled GitHub Actions
workflow both work), the off-site copy only happens when someone runs it
by hand.

### Steps

1. **Confirm what Railway is actually doing.** In the Railway project →
   Postgres service → Backups tab, confirm automated backups are enabled
   and check the retention window. (This depends on the Railway plan —
   confirm the current plan actually includes it; some tiers don't.)

2. **Take a manual snapshot before testing anything else**, independent of
   Railway's own backup, so this test can't itself put production at risk:
   ```bash
   cd backend && DATABASE_URL="..." npm run backup
   ```

3. **Restore into a throwaway database** — never the production one:
   ```bash
   # A fresh empty Railway Postgres instance (or local Postgres) works fine.
   cd backend
   DATABASE_URL="$SCRATCH_DATABASE_URL" CONFIRM_RESTORE=YES npm run restore -- backups/marketbridge-<timestamp>.dump
   ```

4. **Verify the restore, not just that the command exited 0:**
   - Row counts on a few high-value tables match production at the time
     of the dump: `User`, `Order`, `Payment`, `Advertisement`.
   - Spot-check a recent `Payment` row's `status`/`amount`/`providerTransactionId`
     against what Chapa's dashboard shows for the same transaction.
   - Run `npx prisma migrate status` against the restored DB — it should
     report the same applied-migrations state as production, confirming
     the dump captured schema, not just rows.
   - Point a local copy of the backend at `SCRATCH_DATABASE_URL` and
     confirm the app actually boots and logs in as a test user against
     the restored data.

5. **Time the whole thing** (dump → restore → verified) and write the
   number down. That number is the real recovery-time estimate for an
   incident — "we have backups" isn't an answer if nobody knows whether
   restoring takes 10 minutes or 4 hours.

6. **Repeat on a schedule** (quarterly is reasonable) — restore procedures
   silently rot as the schema grows (new tables, new required columns) or
   as data volume grows past what was tested.

### What's stored outside Postgres (not covered by a DB backup)

- **Object storage (S3/R2)** — listing photos, ad creative, evidence,
  digital product files. Confirm the bucket has versioning or its own
  backup/lifecycle policy; a Postgres restore alone won't bring these
  back if the bucket is separately lost. `src/utils/objectStorage.js` is
  the single place all of this goes through, if auditing what's stored.
- **Environment variables / secrets** — not in the database at all. Keep
  a secure copy (password manager / Render's own env-var history) outside
  of what a DB restore covers.

---

## 2. Secrets rotation

Every secret the app currently reads from the environment, what rotating
it actually does, and the blast radius of doing so:

| Variable | Used for | Blast radius when rotated |
|---|---|---|
| `DATABASE_URL` | Postgres connection (Prisma) | None if done as a coordinated cutover (new credential, then update Render env var, then restart) — Railway supports adding a new DB user without dropping the old one mid-rotation. |
| `JWT_SECRET` | Signs access tokens | **Every currently-issued access token stops verifying immediately.** All logged-in users get a 401 on their next request and have to let the refresh flow re-issue a token (or re-login if their refresh session also needs rotating — see below). Low-traffic-window rotation recommended. |
| `JWT_REFRESH_SECRET` | Signs refresh tokens (`middleware/auth.js`, `routes/auth.js`) | **Every refresh session is invalidated** — every logged-in user is fully logged out, not just access-token-expired. More disruptive than rotating `JWT_SECRET` alone; do this only when actually compromised, not on a routine schedule. |
| `PAYMENT_WEBHOOK_SECRET` | HMAC-verifies the generic/manual webhook endpoint in `routes/payments.js` (for non-Chapa or manually-relayed payment events) | Any webhook sent using the old secret will be rejected until the sender is updated with the new one too — **coordinate the change with whatever calls this endpoint in the same window**, or in-flight payment confirmations will fail signature verification and get stuck. |
| `CHAPA_SECRET_KEY` | Authenticates outbound calls to Chapa's API | Old key stops working for new payment-initialization calls the moment it's revoked on Chapa's side. Rotate by generating the new key in the Chapa dashboard first, updating Render's env var, confirming a test payment initializes, *then* revoking the old key. |
| `CHAPA_WEBHOOK_SECRET` | HMAC-verifies Chapa's own native webhook (`config/chapa.js`) — separate secret from `PAYMENT_WEBHOOK_SECRET` above, guarding a different endpoint | Same coordination requirement: update it in Chapa's dashboard and Render's env var in the same window, or Chapa's webhook deliveries will fail verification until both sides match. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | All object storage reads/writes/signing (`utils/objectStorage.js`), and off-site DB backup upload/list/prune (`scripts/backupStorage.js`, same credentials) | Every signed URL currently in a user's browser (max 15 min lifetime per `MEDIA_SIGNED_URL_EXPIRES_SECONDS`) still resolves fine since those are pre-signed with the *old* key until they naturally expire; anything signed *after* rotation uses the new key. Safe to rotate without a maintenance window — just update the env var and restart. |
| `S3_BACKUP_BUCKET` (optional) | Off-site DB backup storage bucket (`scripts/backupStorage.js`) — falls back to `S3_BUCKET` if unset | Not a secret itself, but changing it means old backups uploaded under the previous bucket are no longer listed by `npm run backup:list` (they still exist there, just not visible from this bucket setting). |
| `SMTP_PASS` | Password-reset email delivery (`utils/mailer.js`) | No user-facing impact until the old password actually stops working — just update and restart. |
| `AFROMESSAGE_API_KEY` | SMS delivery (`utils/smsService.js`) | Same — safe, no session/token impact. |
| `SMS_INBOUND_WEBHOOK_SECRET` | Shared secret guarding the inbound SMS webhook (`routes/sms.js`) that lets a registered seller create/activate a listing by text | Rotate by updating the env var and whatever SMS provider config points at this webhook in the same window — until both match, inbound SMS commands will be rejected with 401 (fails closed, not open, if unset). |
| `MFA_ENCRYPTION_KEY` | Encrypts each user's TOTP secret at rest (`utils/mfaCrypto.js`) | **Do not rotate this casually.** Every admin's stored `mfaSecret` was encrypted with the current key; rotating it without re-encrypting existing rows makes those secrets permanently undecryptable, locking every MFA-enabled admin out until they disable and re-enroll MFA. If this ever needs rotating, it requires a migration script that decrypts with the old key and re-encrypts with the new one in the same transaction — don't just swap the env var. |
| `METRICS_TOKEN` | Bearer-auth for `GET /metrics` | No user impact — just update whatever scrapes the endpoint at the same time. |

### General rotation steps (for the safe-to-rotate ones)

1. Generate the new value (32+ random bytes, base64 or hex per what the
   variable expects — see `utils/mfaCrypto.js`'s comment for the one
   fixed-length exception).
2. Set it in Render's environment variables for the backend service.
3. Redeploy (Render restarts the process, which is when the new value
   takes effect — there's no hot-reload of env vars).
4. Confirm with a smoke test specific to that secret (log in, initialize a
   test payment, request a password reset, etc. — whichever exercises the
   path that secret guards).
5. Only after the new value is confirmed working, revoke/invalidate the
   old value on the provider's side (Chapa dashboard, SMTP provider, etc.)
   where applicable.

### What's confirmed clean from a code audit

Grepped the full `backend/src` and `frontend/src` trees for hardcoded
credentials (API key patterns, private key blocks, embedded DB connection
strings) and for insecure fallback defaults (`process.env.X || 'some
default'` on any secret) — found none. Every secret above is read from
`process.env` with no fallback, so a missing one fails loudly (see
`index.js`'s `validateEnv()`) rather than silently running with a weak
default.

**Standing reminder from `SECURITY_NOTES.md`:** any credential that was
ever present in a previously-shared/uploaded archive (zip files sent to
tooling, committed `.env`, etc.) should be treated as already compromised
and rotated regardless of whether misuse has been observed.
