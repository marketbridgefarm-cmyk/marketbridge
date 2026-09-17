# Locale files

This app uses a small dependency-free i18n layer (`src/context/I18nContext.jsx`):
each locale is a flat `"key": "value"` JSON dictionary, and a lookup that misses
in the active language falls back to `en.json`, then to the raw key itself.

## Files

- `en.json` — source of truth. Every key used in the app must exist here first.
- `am.json` — Amharic. Fully translated and kept in parity with `en.json`.
- `om.json` — Afaan Oromo. Partially translated (see below).

## Keeping locales in sync

`scripts/check-locale-parity.cjs` (run it with `node scripts/check-locale-parity.cjs`)
fails if any locale file is missing a key that another one has. Run it after
adding or renaming any translation key, before opening a PR.

## Adding a new key

1. Add it to `en.json` first.
2. Add the same key to every other locale file — even if you don't have a real
   translation yet, add it with the English text as a placeholder (see below).
   The parity script only checks that keys exist, not translation quality, so
   a placeholder keeps the file complete and the check green.
3. Run the parity script to confirm.

## Afaan Oromo (`om.json`) — translation status

Afaan Oromo coverage is intentionally incomplete: keys that don't yet have a
real Afaan Oromo translation are filled in with their literal English text as
a placeholder, rather than guessed at. This is functionally identical to the
app's own runtime fallback (an untranslated key would resolve to the English
string anyway) — the placeholder just makes the gap visible in the file
itself instead of hiding it behind fallback logic, so it's easy to find and
fix.

**Keys currently holding an English placeholder in `om.json`, pending a
native-speaker translation:**

- `nav.farmProduces`, `nav.products`, `nav.digital`, `nav.accountSecurity`
- `auth.welcomeBack`, `auth.loginTitle`, `auth.email`, `auth.password`,
  `auth.forgotPassword`, `auth.newToMarketBridge`, `auth.createAccount`,
  `auth.backToLogin`
- `common.loading`

Payment, refund, and dispute wording deserve particular care if/when they're
translated (or re-translated) — mistranslation there has real financial
consequences for users. The same caution applies to `am.json`: it is fully
translated key-for-key, but has not been reviewed by a native Amharic
speaker, so treat its payment/refund/dispute strings as unverified until
someone fluent signs off on them.

## Adding a new language

1. Copy `en.json` to `<code>.json` (BCP-47-ish short code, e.g. `so.json`).
2. Translate every value.
3. Add `{ code: '<code>', label: '<Native name>' }` to `LANGUAGES` in
   `src/context/I18nContext.jsx` and import/register the new dictionary in
   `DICTIONARIES`.
4. Run the parity script.
