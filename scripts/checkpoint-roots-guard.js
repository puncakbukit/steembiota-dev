#!/usr/bin/env node
const fs = require('fs');

const src = fs.readFileSync('state.js', 'utf8');
const start = src.indexOf('const CHECKPOINT_ROOTS = [');
if (start < 0) {
  console.error('CHECKPOINT_ROOTS declaration not found in state.js');
  process.exit(1);
}
const end = src.indexOf('];', start);
if (end < 0) {
  console.error('Could not parse CHECKPOINT_ROOTS block.');
  process.exit(1);
}
const block = src.slice(start, end + 2);

if (block.includes('REPLACE_WITH_')) {
  console.error('CHECKPOINT_ROOTS contains placeholder markers (REPLACE_WITH_).');
  process.exit(1);
}

const stateHashMatches = [...block.matchAll(/state_hash:\s*"([^"]+)"/g)].map(m => m[1]);
if (stateHashMatches.length === 0) {
  console.error('No state_hash entries found in CHECKPOINT_ROOTS.');
  process.exit(1);
}
for (const h of stateHashMatches) {
  if (!/^[a-f0-9]{64}$/i.test(h)) {
    console.error(`Invalid state_hash in CHECKPOINT_ROOTS: ${h}`);
    process.exit(1);
  }
}

const cidMatches = [...block.matchAll(/snapshot_cid:\s*"([^"]+)"/g)].map(m => m[1]);
if (cidMatches.length === 0) {
  console.error('No snapshot_cid entries found in CHECKPOINT_ROOTS.');
  process.exit(1);
}
for (const cid of cidMatches) {
  const ok = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid) || /^bafy[a-z2-7]{20,}$/.test(cid);
  if (!ok) {
    console.error(`Invalid snapshot_cid in CHECKPOINT_ROOTS: ${cid}`);
    process.exit(1);
  }
}

console.log('CHECKPOINT_ROOTS guard passed.');
