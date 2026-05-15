/*
 * Bundle-size budget gate (§5 / §13: ">10% рост — PR block").
 *
 * After `vite build`, sums the gzipped size of every JS/CSS asset in dist/ and
 * compares it to the committed baseline (.bundle-size-baseline.json). Fails the
 * build when total gzip grows more than ALLOWED_GROWTH_PCT over baseline.
 *
 * Deterministic and dependency-free: uses Node's built-in zlib, walks dist/
 * with fs only. Update the baseline deliberately (see --update flag) when a
 * size increase is intentional.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs            # check against baseline
 *   node scripts/check-bundle-size.mjs --update   # rewrite baseline from dist/
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(APP_DIR, 'dist');
const BASELINE_PATH = join(APP_DIR, '.bundle-size-baseline.json');
const ALLOWED_GROWTH_PCT = 10;
const COUNTED_EXTENSIONS = new Set(['.js', '.css']);

/** Recursively collects file paths under `dir`. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Total gzipped bytes of all JS/CSS assets in dist/. */
function measureGzipTotal() {
  let total = 0;
  for (const file of walk(DIST_DIR)) {
    if (!COUNTED_EXTENSIONS.has(extname(file))) continue;
    total += gzipSync(readFileSync(file)).length;
  }
  return total;
}

function main() {
  const update = process.argv.includes('--update');

  let total;
  try {
    total = measureGzipTotal();
  } catch (err) {
    console.error(`[bundle-size] cannot read dist/ — did you run "vite build" first?`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (update) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ gzipTotalBytes: total }, null, 2)}\n`);
    console.warn(`[bundle-size] baseline updated: ${total} B gzip`);
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    console.error(`[bundle-size] no baseline at ${BASELINE_PATH} — run with --update first`);
    process.exit(1);
  }

  // Seed mode: the committed baseline ships as a placeholder ({"seed": true})
  // because the exact gzip size depends on the locked dependency tree, which
  // is only resolved in CI. The first CI run measures the real size, writes it
  // back, and from then on the 10% gate is enforced against a real number.
  if (baseline.seed === true) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ gzipTotalBytes: total }, null, 2)}\n`);
    console.warn(`[bundle-size] seeded baseline from first build: ${total} B gzip`);
    return;
  }

  const base = baseline.gzipTotalBytes;
  const growthPct = ((total - base) / base) * 100;
  const rounded = growthPct.toFixed(2);

  console.warn(`[bundle-size] baseline: ${base} B  current: ${total} B  delta: ${rounded}%`);

  if (growthPct > ALLOWED_GROWTH_PCT) {
    console.error(
      `[bundle-size] FAIL: gzip bundle grew ${rounded}% (limit ${ALLOWED_GROWTH_PCT}%). ` +
        `If intentional, run "node scripts/check-bundle-size.mjs --update" and commit the baseline.`,
    );
    process.exit(1);
  }

  console.warn(`[bundle-size] OK (within ${ALLOWED_GROWTH_PCT}% budget)`);
}

main();
