#!/usr/bin/env node
'use strict';

/**
 * Generates openapi/openapi.json from the actual Express route files.
 *
 * Why generate instead of hand-write: this API has 140+ endpoints defined
 * with express-validator chains that already encode the ground truth for
 * parameters, and the route table in src/index.js already encodes the
 * ground truth for path prefixes and auth/role gates. A hand-written spec
 * drifts the first time someone adds or changes a route; this script reads
 * the same source of truth the server itself uses, so `npm run docs:generate`
 * after any route change keeps docs/openapi.json honest.
 *
 * What it extracts automatically (high confidence):
 *   - path, HTTP method, mount prefix (from src/index.js app.use() calls)
 *   - path parameters (from `:id`-style segments)
 *   - body parameters (from express-validator `body('x')...` chains, with
 *     type/required/enum/length inferred from the chained validators)
 *   - query parameters actually read via `req.query.x` in the handler
 *   - auth requirement (`authenticate` vs `optionalAuthenticate`) and role
 *     gates (`requireRole(...)`) and MFA gates (`requireMfa()`)
 *   - the set of HTTP status codes the handler actually returns
 *
 * What it does NOT attempt to infer (left generic on purpose, see
 * openapi/overrides.js for hand-authored enrichment of the high-traffic
 * endpoints): full response body shapes. Success responses are typed
 * `object` unless an override supplies a real schema. Do not treat an
 * unoverridden 200 response as "the API returns nothing interesting" — it
 * means nobody has enriched that one yet. See README in this folder.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(BACKEND_ROOT, 'src/routes');
const INDEX_FILE = path.join(BACKEND_ROOT, 'src/index.js');
const OUT_FILE = path.join(BACKEND_ROOT, 'openapi/openapi.json');

const overrides = require('../openapi/overrides.js');
const { components, securitySchemes } = require('../openapi/components.js');

// ---------------------------------------------------------------------------
// 1. Figure out which route file mounts at which prefix, by reading index.js
//    the same way Express does: const fooRoutes = require('./routes/foo');
//    ... app.use('/api/foo', fooRoutes);
// ---------------------------------------------------------------------------
function getMountTable() {
  const src = fs.readFileSync(INDEX_FILE, 'utf8');

  const varToFile = {};
  const reqRe = /const\s+(\w+)\s*=\s*require\(['"]\.\/routes\/([\w-]+)['"]\)/g;
  let m;
  while ((m = reqRe.exec(src))) {
    varToFile[m[1]] = m[2];
  }

  const mounts = []; // { prefix, file }
  const useRe = /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g;
  while ((m = useRe.exec(src))) {
    const [, prefix, varName] = m;
    if (varToFile[varName]) {
      mounts.push({ prefix, file: varToFile[varName] });
    }
  }
  return mounts;
}

// ---------------------------------------------------------------------------
// 2. Split a route file into one chunk per top-level `router.METHOD(` call.
//    Route definitions in this codebase are always unindented top-level
//    statements (verified: anchored vs unanchored grep counts match for
//    every file), so splitting on that anchor is safe.
// ---------------------------------------------------------------------------
const METHOD_RE = /^router\.(get|post|put|patch|delete)\(/;

function splitIntoChunks(src) {
  const lines = src.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (METHOD_RE.test(line)) starts.push(i);
  });
  const chunks = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const chunkLines = lines.slice(start, end);
    const method = lines[start].match(METHOD_RE)[1];
    // Leading comment block directly above this route (for a description).
    let c = start - 1;
    const commentLines = [];
    while (c >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[c])) {
      commentLines.unshift(lines[c]);
      c--;
    }
    chunks.push({
      method,
      text: chunkLines.join('\n'),
      leadingComment: commentLines.join('\n'),
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 3. Pull the literal path out of `router.get('/foo/:id', ...)`. Handles
//    both single-line and the multi-line `router.post(\n  '/path',\n ...)`
//    style used for routes with a validator array.
// ---------------------------------------------------------------------------
function extractRoutePath(chunkText) {
  const m = chunkText.match(/^router\.\w+\(\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 4. Only look at the "header" of the chunk — from the router.METHOD( call
//    up to the start of the handler's function body — for middleware
//    detection, so we don't false-positive on a helper elsewhere in the
//    handler that happens to be named similarly.
// ---------------------------------------------------------------------------
function extractHeader(chunkText) {
  const handlerStart = chunkText.search(/async\s*\(req,\s*res\)|function\s*\(req,\s*res\)|\(req,\s*res\)\s*=>/);
  return handlerStart === -1 ? chunkText.slice(0, 400) : chunkText.slice(0, handlerStart);
}

function extractAuth(header) {
  const auth = {
    required: /(^|[^\w])authenticate(?!d)/.test(header) && !/optionalAuthenticate/.test(header),
    optional: /optionalAuthenticate/.test(header),
    roles: [],
    mfa: /requireMfa\(\)/.test(header),
  };
  const roleRe = /requireRole\(([^)]*)\)/;
  const rm = header.match(roleRe);
  if (rm) {
    auth.roles = rm[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return auth;
}

function extractUpload(header) {
  return /multer|evidenceUpload|upload\.(single|array|fields)/.test(header);
}

// ---------------------------------------------------------------------------
// 5. Path parameters from `:id`-style segments.
// ---------------------------------------------------------------------------
function extractPathParams(routePath) {
  const params = [];
  const re = /:([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(routePath))) {
    params.push({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: /id$/i.test(m[1]) ? 'string' : 'string' },
      description: 'Path parameter (see route).',
    });
  }
  return params;
}

// ---------------------------------------------------------------------------
// 6. express-validator body() chains -> request body schema.
//    Only looks inside the validator array (the `[ ... ]` immediately
//    after the path, before the handler function), so we don't pick up
//    unrelated body('x') calls that might appear deeper in a handler.
// ---------------------------------------------------------------------------
function extractValidatorArray(chunkText) {
  const arrStart = chunkText.indexOf('[');
  const handlerMatch = chunkText.search(/async\s*\(req,\s*res\)/);
  if (arrStart === -1 || handlerMatch === -1 || arrStart > handlerMatch) return null;
  // naive bracket match from arrStart
  let depth = 0;
  for (let i = arrStart; i < chunkText.length; i++) {
    if (chunkText[i] === '[') depth++;
    if (chunkText[i] === ']') {
      depth--;
      if (depth === 0) return chunkText.slice(arrStart + 1, i);
    }
  }
  return null;
}

function fieldTypeFromChain(chain) {
  if (/\.isEmail\(/.test(chain)) return { type: 'string', format: 'email' };
  if (/\.isInt\(/.test(chain)) return { type: 'integer' };
  if (/\.isFloat\(/.test(chain)) return { type: 'number' };
  if (/\.isBoolean\(/.test(chain)) return { type: 'boolean' };
  if (/\.isArray\(/.test(chain)) return { type: 'array', items: {} };
  if (/\.isISO8601\(/.test(chain)) return { type: 'string', format: 'date-time' };
  if (/\.isUUID\(/.test(chain)) return { type: 'string', format: 'uuid' };
  return { type: 'string' };
}

function extractBodyFields(validatorArrayText) {
  if (!validatorArrayText) return [];
  const fieldRe = /\bbody\(\s*['"]([\w.[\]]+)['"]\s*\)/g;
  const hits = [];
  let m;
  while ((m = fieldRe.exec(validatorArrayText))) {
    hits.push({ name: m[1], index: m.index });
  }
  return hits.map((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : validatorArrayText.length;
    const chain = validatorArrayText.slice(hit.index, end);
    const schema = fieldTypeFromChain(chain);

    const enumMatch = chain.match(/\.isIn\(\s*\[([^\]]*)\]/);
    if (enumMatch) {
      schema.enum = enumMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
    const lenMatch = chain.match(/\.isLength\(\s*\{([^}]*)\}/);
    if (lenMatch) {
      const minMatch = lenMatch[1].match(/min:\s*(\d+)/);
      const maxMatch = lenMatch[1].match(/max:\s*(\d+)/);
      if (minMatch) schema.minLength = Number(minMatch[1]);
      if (maxMatch) schema.maxLength = Number(maxMatch[1]);
    }

    return {
      name: hit.name,
      required: !/\.optional\(/.test(chain),
      schema,
    };
  });
}

// ---------------------------------------------------------------------------
// 7. Query params actually read via req.query.xxx in the handler body.
//    Best-effort: no type info available from usage alone, so these come
//    back as optional strings unless an override adds detail.
// ---------------------------------------------------------------------------
function extractQueryParams(chunkText) {
  const re = /req\.query(?:\.(\w+)|\[['"](\w+)['"]\])/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(chunkText))) {
    const name = m[1] || m[2];
    if (name) seen.add(name);
  }
  return [...seen].map((name) => ({
    name,
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Detected from handler usage; see overrides.js to add precise typing.',
  }));
}

// ---------------------------------------------------------------------------
// 8. Status codes the handler actually sends.
// ---------------------------------------------------------------------------
function extractStatusCodes(chunkText) {
  const re = /res\.status\((\d{3})\)/g;
  const codes = new Set();
  let m;
  while ((m = re.exec(chunkText))) codes.add(Number(m[1]));
  return codes;
}

function primarySuccessCode(codes) {
  if (codes.has(201)) return 201;
  if (codes.has(200)) return 200;
  if (codes.has(204)) return 204;
  const success = [...codes].filter((c) => c < 300);
  return success.length ? success[0] : 200;
}

const STANDARD_ERROR_DESCRIPTIONS = {
  400: 'Validation failed or the request was malformed.',
  401: 'Missing, invalid, or expired access token.',
  403: 'Authenticated, but not permitted to perform this action.',
  404: 'The requested resource does not exist.',
  409: 'The request conflicts with the current state of the resource.',
  422: 'The request was well-formed but semantically invalid.',
  429: 'Too many requests — rate limit exceeded.',
  500: 'Unexpected server error.',
};

// ---------------------------------------------------------------------------
// 9. Build one OpenAPI operation object per chunk.
// ---------------------------------------------------------------------------
function tagFromFile(file) {
  return file
    .replace(/\.js$/, '')
    .split(/[-_]/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function cleanComment(comment) {
  return comment
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/|\/\*\*?|\*\/?)\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function buildOperation({ mount, file, chunk, opIdCounts }) {
  const routePathRaw = extractRoutePath(chunk.text);
  if (!routePathRaw) return null;

  const fullPath = (mount.prefix + (routePathRaw === '/' ? '' : routePathRaw)).replace(/\/{2,}/g, '/');
  const openApiPath = fullPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

  const header = extractHeader(chunk.text);
  const auth = extractAuth(header);
  const hasUpload = extractUpload(header);
  const validatorArrayText = extractValidatorArray(chunk.text);
  const bodyFields = extractBodyFields(validatorArrayText);
  const pathParams = extractPathParams(routePathRaw);
  const queryParams = extractQueryParams(chunk.text).filter(
    (q) => !pathParams.some((p) => p.name === q.name)
  );
  const statusCodes = extractStatusCodes(chunk.text);
  const successCode = primarySuccessCode(statusCodes);

  const tag = tagFromFile(file);
  const baseOpId = `${chunk.method}_${openApiPath}`
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  opIdCounts[baseOpId] = (opIdCounts[baseOpId] || 0) + 1;
  const operationId = opIdCounts[baseOpId] > 1 ? `${baseOpId}_${opIdCounts[baseOpId]}` : baseOpId;

  const description = cleanComment(chunk.leadingComment);

  const authNote = auth.required
    ? auth.roles.length
      ? `Requires a valid access token with role: ${auth.roles.join(' or ')}.`
      : 'Requires a valid access token.'
    : auth.optional
    ? 'Works without authentication; behavior may differ for authenticated requests.'
    : 'No authentication required.';
  const mfaNote = auth.mfa ? ' Requires MFA to be enabled on the calling account.' : '';
  const uploadNote = hasUpload ? ' Accepts multipart/form-data file upload(s).' : '';

  const operation = {
    operationId,
    summary: description || `${chunk.method.toUpperCase()} ${openApiPath}`,
    description: `${authNote}${mfaNote}${uploadNote}`,
    tags: [tag],
    parameters: [...pathParams, ...queryParams],
    responses: {},
  };

  if (auth.required || auth.optional) {
    operation.security = auth.required ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, {}];
  }

  if (bodyFields.length && !hasUpload) {
    const properties = {};
    const required = [];
    bodyFields.forEach((f) => {
      properties[f.name] = f.schema;
      if (f.required) required.push(f.name);
    });
    operation.requestBody = {
      required: required.length > 0,
      content: {
        'application/json': {
          schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        },
      },
    };
  } else if (hasUpload) {
    operation.requestBody = {
      content: {
        'multipart/form-data': {
          schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
        },
      },
    };
  }

  const successSchema = { type: 'object' };
  operation.responses[String(successCode)] = {
    description: successCode === 204 ? 'Success (no content).' : 'Success.',
    ...(successCode === 204
      ? {}
      : { content: { 'application/json': { schema: successSchema } } }),
  };

  [...statusCodes]
    .filter((c) => c >= 300)
    .forEach((code) => {
      operation.responses[String(code)] = {
        description: STANDARD_ERROR_DESCRIPTIONS[code] || 'Error.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
    });

  if (auth.required && !operation.responses['401']) {
    operation.responses['401'] = {
      description: STANDARD_ERROR_DESCRIPTIONS[401],
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  return { path: openApiPath, method: chunk.method, operation };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const mounts = getMountTable();
  if (!mounts.length) {
    console.error('No route mounts found in src/index.js — aborting.');
    process.exit(1);
  }

  const paths = {};
  const opIdCounts = {};
  let total = 0;

  for (const mount of mounts) {
    const filePath = path.join(ROUTES_DIR, `${mount.file}.js`);
    if (!fs.existsSync(filePath)) {
      console.warn(`Skipping ${mount.file}: file not found at ${filePath}`);
      continue;
    }
    const src = fs.readFileSync(filePath, 'utf8');
    const chunks = splitIntoChunks(src);

    for (const chunk of chunks) {
      const built = buildOperation({ mount, file: `${mount.file}.js`, chunk, opIdCounts });
      if (!built) continue;
      const overrideKey = `${built.method.toUpperCase()} ${built.path}`;
      const override = overrides[overrideKey];
      const finalOperation = override ? mergeOverride(built.operation, override) : built.operation;

      if (!paths[built.path]) paths[built.path] = {};
      paths[built.path][built.method] = finalOperation;
      total++;
    }
  }

  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'MarketBridge API',
      version: '1.0.0',
      description:
        'Ethiopian agricultural & digital marketplace API. This spec is generated from the ' +
        'route source (see backend/scripts/generate-openapi.js) plus hand-authored enrichment ' +
        '(see backend/openapi/overrides.js) for the highest-traffic endpoints. Regenerate with ' +
        '`npm run docs:generate` after changing routes.',
    },
    servers: [
      { url: 'http://localhost:4000', description: 'Local development' },
      { url: 'https://{host}', description: 'Deployed environment', variables: { host: { default: 'api.example.com' } } },
    ],
    tags: mounts.map((m) => ({ name: tagFromFile(m.file) })),
    paths,
    components: { ...components, securitySchemes },
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(spec, null, 2));
  console.log(`Wrote ${OUT_FILE} — ${total} operations across ${Object.keys(paths).length} paths.`);
}

function mergeOverride(base, override) {
  const merged = { ...base, ...override };
  if (override.responses) {
    merged.responses = { ...base.responses, ...override.responses };
  }
  if (override.parameters) {
    // Overrides replace a parameter of the same name+in, keep the rest as generated.
    const keep = base.parameters.filter(
      (p) => !override.parameters.some((op) => op.name === p.name && op.in === p.in)
    );
    merged.parameters = [...keep, ...override.parameters];
  }
  return merged;
}

main();
