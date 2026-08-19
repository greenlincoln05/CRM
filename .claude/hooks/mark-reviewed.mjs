#!/usr/bin/env node
/**
 * Records that the current commit has been reviewed, which is what clears the
 * push gate in review-gate.mjs.
 *
 *   node .claude/hooks/mark-reviewed.mjs repo-reviewer
 *   node .claude/hooks/mark-reviewed.mjs repo-reviewer sensitive-data-guard
 *
 * Run it only after a review has actually happened and its findings are either
 * fixed or consciously accepted. Marking an unreviewed commit defeats the point
 * and leaves a false record of who checked what.
 *
 * The marker is gitignored: a review is a fact about this working copy at this
 * moment, not something to carry to another machine.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = resolve(REPO, '.claude/review-state.json');

const reviewers = process.argv.slice(2).filter(Boolean);
if (reviewers.length === 0) {
  console.error('Usage: node .claude/hooks/mark-reviewed.mjs <reviewer> [more...]');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

const commit = git('rev-parse', 'HEAD');
const subject = git('log', '-1', '--pretty=%s');
const dirty = git('status', '--porcelain');

if (dirty) {
  console.error(
    'Refusing to mark: the working tree has uncommitted changes.\n' +
    'The gate records a review of a COMMIT, so commit (or stash) first — otherwise\n' +
    'the marker would vouch for code that is not in the commit being pushed.\n\n' +
    dirty,
  );
  process.exit(1);
}

mkdirSync(dirname(MARKER), { recursive: true });
writeFileSync(MARKER, JSON.stringify({
  commit,
  subject,
  reviewer: reviewers.join(' + '),
  at: new Date().toISOString(),
}, null, 2) + '\n');

console.log(`[review] ${commit.slice(0, 8)} marked reviewed by ${reviewers.join(' + ')}`);
console.log(`         ${subject}`);
