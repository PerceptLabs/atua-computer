#!/usr/bin/env node
/**
 * Verify engine.wasm imports ONLY from "atua" namespace.
 * Fails if any wasi_snapshot_preview1 or wasix_32v1 imports exist.
 *
 * Usage: node test/browser/verify-imports.js [path/to/engine.wasm]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wasmPath = process.argv[2] || resolve('src/browser/engine.wasm');
const data = readFileSync(wasmPath);

// Parse WASM binary — find import section (id=2)
let i = 8; // skip magic + version
const modules = {};

while (i < data.length) {
  const sectionId = data[i++];
  let size = 0, shift = 0;
  while (true) {
    const byte = data[i++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }

  if (sectionId === 2) {
    let pos = i;
    let count = 0;
    shift = 0;
    while (true) {
      const byte = data[pos++];
      count |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }

    for (let j = 0; j < count; j++) {
      const modLen = data[pos++];
      const mod = data.slice(pos, pos + modLen).toString('utf8');
      pos += modLen;
      const fieldLen = data[pos++];
      const field = data.slice(pos, pos + fieldLen).toString('utf8');
      pos += fieldLen;
      const kind = data[pos++];
      // Skip kind-specific data
      if (kind === 0) { // func
        while (data[pos] & 0x80) pos++;
        pos++;
      } else if (kind === 1) { // table
        pos += 3;
      } else if (kind === 2) { // memory
        const flags = data[pos++];
        while (data[pos] & 0x80) pos++;
        pos++;
        if (flags & 1) { while (data[pos] & 0x80) pos++; pos++; }
      } else if (kind === 3) { // global
        pos += 2;
      }
      if (!modules[mod]) modules[mod] = [];
      modules[mod].push({ field, kind });
    }
    break;
  } else {
    i += size;
  }
}

// Report
let failed = false;
for (const [mod, imports] of Object.entries(modules).sort()) {
  const funcs = imports.filter(i => i.kind === 0);
  const label = funcs.length ? `${funcs.length} functions` : `${imports.length} other`;
  console.log(`${mod}: ${label}`);
  for (const f of funcs) console.log(`  ${f.field}`);
}

// Check for forbidden imports
const forbidden = ['wasi_snapshot_preview1', 'wasix_32v1'];
for (const mod of forbidden) {
  if (modules[mod]) {
    console.error(`\nFAIL: Found ${modules[mod].length} imports from "${mod}"`);
    for (const f of modules[mod]) console.error(`  ${f.field}`);
    failed = true;
  }
}

if (!modules['atua'] || modules['atua'].length === 0) {
  console.error('\nFAIL: No "atua" imports found');
  failed = true;
}

if (failed) {
  console.error('\n❌ IMPORT VERIFICATION FAILED');
  process.exit(1);
} else {
  const atuaCount = modules['atua']?.length || 0;
  console.log(`\n✅ PASS: ${atuaCount} atua imports, zero WASI/WASIX`);
}
