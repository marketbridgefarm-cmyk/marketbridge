# API docs

`openapi/openapi.json` is **generated**, not hand-written. Don't edit it directly — regenerate it:

```bash
npm run docs:generate
```

This also runs automatically before `npm run dev` and `npm start` (via `predev`/`prestart`), so the
served spec can't silently go stale in normal use. CI should run it too and fail if it produces a diff
(see "Keeping it honest" below).

Once the server is running:

- **Interactive docs:** `http://localhost:4000/api/docs`
- **Raw spec:** `http://localhost:4000/api/openapi.json`

## Why generated

This API has 140+ endpoints. A hand-written spec for that many routes is out of date within a week —
someone adds a field to a validator chain, or a new endpoint, and the docs and the code silently
diverge. That's worse than no docs, because an integrator trusts it.

Instead, `scripts/generate-openapi.js` reads the same source of truth the server itself uses:

- **Path, method, prefix** — parsed from `src/index.js`'s `app.use('/api/x', xRoutes)` calls and each
  route file's `router.get/post/put/patch/delete(...)` calls.
- **Path parameters** — from `:id`-style segments in the route path.
- **Body parameters** — from `express-validator` `body('x')...` chains: field name, required/optional,
  and type/constraints inferred from the chained validators (`isEmail`, `isInt`, `isIn([...])`,
  `isLength({...})`, etc).
- **Query parameters** — detected from `req.query.x` usage in the handler. These come back as untyped
  optional strings (usage alone doesn't tell you the intended type) unless enriched in `overrides.js`.
- **Auth requirements** — `authenticate` vs `optionalAuthenticate` vs neither, `requireRole(...)`, and
  `requireMfa()`.
- **Status codes** — every `res.status(NNN)` the handler actually calls, so the response list matches
  what the endpoint can really return (not just the happy path).

## What it does NOT infer: response bodies

The generator has no way to know what shape `res.json(...)` actually sends without a much heavier
static-analysis pass, so by default every success response is typed as a bare `object`. That's honest
(a bare object beats a *wrong* schema) but not very useful on its own.

`overrides.js` hand-supplies real response schemas — and anything else worth correcting — for the
endpoints an outside integrator hits first: auth, listings, offers, orders, payments, and one
representative endpoint each for inspections, transport, digital products, ratings, messages, and
disputes. It's keyed by `"METHOD /openapi/path"` and deep-merges over whatever the generator produced,
so you only need to specify what you're adding or correcting.

**When you touch one of the other ~110 endpoints and want it properly documented, add an entry to
`overrides.js` rather than editing `openapi.json`.** Pattern to copy is right there in the file.

## Entity schemas (`components.js`)

`User`, `Listing`, `Order`, `Payment`, etc. are hand-written in `components.js`, sourced from
`prisma/schema.prisma`, with internal-only fields (password hashes, MFA secrets, legacy columns)
deliberately left out. These change far less often than the route table, so unlike `openapi.json`
they're safe to maintain by hand — update the matching schema here when a model's public shape
changes.

## Keeping it honest

CI (`.github/workflows/ci.yml`, "Check openapi.json is up to date") regenerates the spec and fails the
build on a git diff — the same drift check the workflow already does for Prisma migrations, applied to
the API spec. If that step fails, it means someone changed a route and didn't run
`npm run docs:generate` before committing; run it locally and commit the resulting `openapi.json`.
