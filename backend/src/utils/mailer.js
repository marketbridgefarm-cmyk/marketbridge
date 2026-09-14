'use strict';

const nodemailer = require('nodemailer');

// Generic SMTP mailer, shared by the admin MFA email fallback and the
// password-recovery flow (and available for future notification-email work
// — see roadmap item 9). Configured entirely via env vars so it works with
// any provider (SES SMTP, SendGrid SMTP, Mailgun, etc.) without a
// provider-specific SDK dependency.
const REQUIRED = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
const isProduction = process.env.NODE_ENV === 'production';

let cachedTransport = null;

function isConfigured() {
  return REQUIRED.every((key) => !!process.env[key]);
}

function transport() {
  if (cachedTransport) return cachedTransport;

  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || Number(process.env.SMTP_PORT) === 465).toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return cachedTransport;
}

/**
 * Send a transactional email. In production, SMTP must be configured (see
 * index.js validateEnv) so this always actually sends. Outside production,
 * a missing SMTP config falls back to logging the message instead of
 * throwing, so local development doesn't require real mail credentials.
 */
async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) {
    if (isProduction) {
      throw Object.assign(new Error('SMTP is not configured'), { status: 500 });
    }
    console.log(`[mailer:dev] To: ${to}\nSubject: ${subject}\n\n${text || html}`);
    return { devMode: true };
  }

  return transport().sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject,
    text,
    html,
  });
}

module.exports = { sendMail, isConfigured };
