# MarketBridge — CSP & Security Hardening

Implemented the next production-hardening milestone from the enhancement roadmap.

## Included

- Backend Helmet CSP is now enabled instead of disabled.
- Production HSTS is enabled for one year with subdomains and preload.
- Added `frame-ancestors 'none'`, `object-src 'none'`, strict referrer policy, MIME sniffing protection, and cross-origin protections.
- Added an opt-in `/csp-report` endpoint for CSP violation diagnostics.
- Frontend Vercel deployment now emits CSP and baseline security headers.
- Password recovery now sends a real transactional email through the existing SMTP mailer instead of logging reset links in production.
- Production startup now validates `MFA_ENCRYPTION_KEY` and SMTP configuration.
- Added `backend/.env.example` documenting the required production security/email variables.
- Added `nodemailer` to `backend/package.json`.

## Deployment

Configure the new production variables before deploying:

- `MFA_ENCRYPTION_KEY`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`

Generate a 32-byte MFA key with:

```bash
openssl rand -base64 32
```

The extracted repository's `backend/package-lock.json` predates the Step 8 MFA/mail dependencies. CI was changed to use `npm install` so the declared dependency graph is resolved during CI. Regenerate and commit the lockfile from a networked development environment, then change CI back to `npm ci` for fully reproducible installs.
