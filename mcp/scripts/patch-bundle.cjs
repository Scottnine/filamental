#!/usr/bin/env node
// Patches the ncc bundle so that the native-addon asset base path is
// decoded from URL encoding (fixes spaces in directory names on Windows).
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');

const bundlePath = path.join(__dirname, '..', 'bundle', 'index.js');
let src = readFileSync(bundlePath, 'utf8');

const ORIGINAL =
  `__nccwpck_require__.ab = new URL('.', import.meta.url).pathname` +
  `.slice(import.meta.url.match(/^file:\\/\\/\\/\\w:/) ? 1 : 0, -1) + "/";`;

const PATCHED =
  `__nccwpck_require__.ab = decodeURIComponent(new URL('.', import.meta.url).pathname` +
  `.slice(import.meta.url.match(/^file:\\/\\/\\/\\w:/) ? 1 : 0, -1)) + "/";`;

if (!src.includes(ORIGINAL)) {
  if (src.includes(PATCHED)) {
    console.log('patch-bundle: already patched, skipping.');
    process.exit(0);
  }
  console.error('patch-bundle: target string not found — ncc may have changed its output format.');
  console.error('  Looking for:', ORIGINAL);
  process.exit(1);
}

src = src.replace(ORIGINAL, PATCHED);
writeFileSync(bundlePath, src, 'utf8');
console.log('patch-bundle: applied decodeURIComponent fix to bundle/index.js');
