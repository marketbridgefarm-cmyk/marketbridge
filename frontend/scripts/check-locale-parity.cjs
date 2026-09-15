#!/usr/bin/env node
// Fails if any locale file in src/locales/*.json is missing a key that
// another one has. Keeps locales/README.md's "silently falls back to
// English" gap from drifting further without anyone noticing.
'use strict';

const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, '..', 'src', 'locales');
const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));

const keysByFile = {};
for (const file of files) {
  keysByFile[file] = Object.keys(
    JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'))
  );
}

const allKeys = new Set(Object.values(keysByFile).flat());
let hasMissing = false;

for (const [file, keys] of Object.entries(keysByFile)) {
  const missing = [...allKeys].filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    hasMissing = true;
    console.error(`${file} is missing ${missing.length} key(s):`);
    for (const k of missing) console.error(`  - ${k}`);
  }
}

if (hasMissing) {
  console.error('\nAdd the missing keys (see src/locales/README.md).');
  process.exit(1);
}

console.log(`Locale parity OK — ${files.length} files, ${allKeys.size} keys each.`);
