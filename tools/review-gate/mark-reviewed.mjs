#!/usr/bin/env node
/**
 * Records that the current commit has been reviewed, clearing the global push
 * gate for whichever repository you are standing in.
 *
 *   node <this directory>/mark-reviewed.mjs repo-reviewer
 *   node <this directory>/mark-reviewed.mjs repo-reviewer security-reviewer
 *
 * Run it only after a review has actually happened and its findings are fixed
 * or consciously accepted. Marking an unreviewed commit defeats the point and
 * leaves a false record of who checked what.
 *
 * The marker records a COMMIT, so the tree must be clean: a marker written over
 * uncommitted changes would vouch for code the commit does not contain. The
 * marker itself is excluded from that check — it is the one file whose presence
 * cannot be a reason to refuse to write it.
 *
 * It deliberately does NOT touch `.git/info/exclude`. Writing there is a
 * surprising side effect in a file nobody reads, and it breaks outright in a
 * worktree, where `.git` is a file: the append throws, the marker still lands,
 * and the now-untracked marker makes every later mark refuse forever. Add
 * `.claude/review-state.json` to a repo's ignores yourself if the untracked
 * entry bothers you.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const reviewers = process.argv.slice(2).filter(Boolean);
if (reviewers.length === 0) {
  console.error('Usage: node mark-reviewed.mjs <reviewer> [more...]');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let repo;
try {
  repo = git('rev-parse', '--show-toplevel');
} catch {
  console.error('Not inside a git repository.');
  process.exit(1);
}

const marker = resolve(repo, '.claude/review-state.json');

// Everything except the marker itself. `git status --porcelain` reports an
// untracked directory as `?? .claude/`, so match the prefix too.
const dirty = git('status', '--porcelain')
  .split('\n')
  .filter((line) => {
    const path = line.slice(3).trim().replace(/\\/g, '/');
    return line.trim() !== ''
      && path !== '.claude/review-state.json'
      && path !== '.claude/';
  });

if (dirty.length > 0) {
  console.error(
    'Refusing to mark: the working tree has uncommitted changes.\n' +
    'The gate records a review of a COMMIT, so commit (or stash) first —\n' +
    'otherwise the marker vouches for code the commit does not contain.\n\n' +
    dirty.join('\n'),
  );
  process.exit(1);
}

const commit = git('rev-parse', 'HEAD');
const subject = git('log', '-1', '--pretty=%s');

mkdirSync(dirname(marker), { recursive: true });
writeFileSync(marker, JSON.stringify({
  commit,
  subject,
  reviewer: reviewers.join(' + '),
  at: new Date().toISOString(),
}, null, 2) + '\n');

console.log(`[review] ${commit.slice(0, 8)} marked reviewed by ${reviewers.join(' + ')}`);
console.log(`         ${subject}`);
console.log(`         ${repo}`);
