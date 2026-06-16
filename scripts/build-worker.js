#!/usr/bin/env node
// Reads env vars set by release.sh, fills worker.template.js placeholders,
// writes cloudflare/worker.js ready for wrangler deploy.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const { VERSION, PUB_DATE, RELEASE_NOTES, EXE_URL, MSI_URL, SIG_PATH, DMG_URL } = process.env;

const sig          = readFileSync(SIG_PATH, 'utf8').trim();

// Preserve existing DMG URL across Windows-only releases
let dmgUrl = DMG_URL || '';
if (!dmgUrl) {
  const existing = readFileSync(join(root, 'cloudflare/worker.js'), 'utf8');
  const m = existing.match(/const DOWNLOAD_DMG = "([^"]+)"/);
  if (m) dmgUrl = m[1];
}
const skillMd      = readFileSync(join(root, 'skills', 'filamental_SKILL.md'), 'utf8');
const formatRefMd  = readFileSync(join(root, 'skills', 'filamental_format_reference.md'), 'utf8');

let out = readFileSync(join(root, 'cloudflare/worker.template.js'), 'utf8');

// Function form of replace bypasses JS special replacement patterns ($&, $1 etc.)
out = out
  .replace('__VERSION__',           () => VERSION)
  .replace('__PUB_DATE__',          () => PUB_DATE)
  .replace('__RELEASE_NOTES__',     () => RELEASE_NOTES.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'))
  .replace('__EXE_URL__',           () => EXE_URL)
  .replace('__MSI_URL__',           () => MSI_URL)
  .replace('__DMG_URL__',           () => dmgUrl)
  .replace('__SIGNATURE__',         () => sig)
  .replace('__SKILL_FILAMENTAL__',  () => JSON.stringify(skillMd))
  .replace('__SKILL_FORMAT_REF__',  () => JSON.stringify(formatRefMd));

writeFileSync(join(root, 'cloudflare/worker.js'), out);
console.log('  cloudflare/worker.js generated');
