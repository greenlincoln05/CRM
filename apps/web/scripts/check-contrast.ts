/**
 * The spec's contrast rule, enforced: every text-bearing token pair in
 * office.css ships at >= 4.5:1 (WCAG AA). Parses the .office token block
 * and checks the declared pairs below. Change a token, run this.
 *
 *   npx tsx apps/web/scripts/check-contrast.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dirname, '../app/office.css'), 'utf8');

const tokens = new Map<string, string>();
for (const m of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  if (!tokens.has(m[1]!)) tokens.set(m[1]!, m[2]!.toLowerCase());
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function ratio(a: string, b: string): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}
const val = (name: string): string => {
  if (name.startsWith('#')) return name.toLowerCase();
  const v = tokens.get(name);
  if (!v) { console.log(`FAIL  token ${name} not found in office.css`); process.exit(1); }
  return v;
};

// Every pair that carries text. Update alongside office.css.
const PAIRS: [fg: string, bg: string, where: string][] = [
  ['--text', '--surface', 'body text on cards'],
  ['--text', '--bg', 'body text on canvas'],
  ['--text-strong', '--surface', 'headings'],
  ['--text-dim', '--surface', 'secondary text on cards'],
  ['--text-dim', '--bg', 'secondary text on canvas'],
  ['--text-dim', '--surface-2', 'chips and kbd hints'],
  ['--accent', '--surface', 'links and active nav'],
  ['--accent', '--accent-soft', 'active nav item text'],
  ['#ffffff', '--accent', 'primary button label'],
  ['--ok', '--surface', 'success text'],
  ['--ok', '--ok-soft', 'success chip text'],
  ['--danger', '--surface', 'danger and over-capacity text'],
  ['--danger', '--danger-soft', 'danger chip text'],
  ['--warn', '--surface', 'warning text'],
  ['--warn', '--warn-soft', 'warning chip text (gold tint)'],
];

let failures = 0;
for (const [fg, bg, where] of PAIRS) {
  const r = ratio(val(fg), val(bg));
  const ok = r >= 4.5;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2)}:1  ${fg} on ${bg}  (${where})`);
  if (!ok) failures++;
}
console.log(failures ? `\n${failures} pair(s) under 4.5:1` : '\nAll pairs pass WCAG AA.');
process.exit(failures ? 1 : 0);
