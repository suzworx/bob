import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/*
 * fetch-verified.mjs <url> <sha256> <out> — the Dockerfile's tools stage.
 *
 * Downloads one pinned release file and writes it only when its sha256 matches,
 * so a changed or tampered download fails the build. Node's own fetch replaces
 * the apt-get install of curl, which cost 30-45 s on every cold image build
 * (#1307).
 */

const [url, expected, out] = process.argv.slice(2);
if (!url || !/^[0-9a-f]{64}$/.test(expected ?? '') || !out) {
  console.error('usage: fetch-verified.mjs <url> <sha256> <out>');
  process.exit(2);
}

let body;
for (let attempt = 1; ; attempt++) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
    break;
  } catch (error) {
    if (attempt === 3) {
      console.error(`fetch ${url} failed: ${error.message}`);
      process.exit(1);
    }
  }
}

const actual = createHash('sha256').update(body).digest('hex');
if (actual !== expected) {
  console.error(`sha256 mismatch for ${url}: expected ${expected}, got ${actual}`);
  process.exit(1);
}
writeFileSync(out, body);
console.log(`${out}: ${body.length} bytes, sha256 ok`);
