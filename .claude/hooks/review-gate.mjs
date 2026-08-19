#!/usr/bin/env node
/**
 * Blocks `git push` until repo-reviewer has reviewed the exact commit being pushed.
 *
 * The review step is easy to skip precisely when skipping it is most expensive —
 * end of a long session, everything passing, one command from done. This repo has
 * already lost three files to a push nobody checked (commit 56bf5be), so the gate
 * is a hook rather than a line in CLAUDE.md.
 *
 * How it clears: after committing, `node .claude/hooks/mark-reviewed.mjs <reviewer>`
 * records the current HEAD. Commit again and the marker is stale, so amending or
 * adding "one more small fix" re-arms the gate rather than sneaking past it.
 *
 * Deliberately matches loosely — any Bash command containing both `git` and `push`
 * is checked, including `cd x && git push` and `git -C path push`. A gate with an
 * obvious phrasing bypass is decoration.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = resolve(REPO, '.claude/review-state.json');

const allow = () => process.exit(0);

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let payload = '';
try {
  payload = readFileSync(0, 'utf8');
} catch {
  allow(); // no stdin to read: not our business
}

let input;
try {
  input = JSON.parse(payload);
} catch {
  allow(); // unparseable payload is the harness's problem, not a reason to block work
}

if (input?.tool_name !== 'Bash') allow();

const command = String(input?.tool_input?.command ?? '');
// Both words, in order, as whole words — catches `git push`, `git -C x push`,
// `cd x && git push`, and misses `grep push` or `git log --grep=pushed`.
if (!/\bgit\b[^\n;|&]*\bpush\b/.test(command)) allow();

// `--dry-run` changes nothing on the remote, so let it through.
if (/--dry-run\b/.test(command)) allow();

let head;
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
} catch {
  allow(); // no HEAD yet (or not a repo) — nothing to have reviewed
}

if (!existsSync(MARKER)) {
  deny(
    'Push blocked: no review on record.\n\n' +
    'Every code change goes through repo-reviewer before it reaches the remote — ' +
    'and sensitive-data-guard too if it touches gate codes, access notes, photos, or PII.\n\n' +
    'When the review is done and its findings are addressed:\n' +
    '  node .claude/hooks/mark-reviewed.mjs repo-reviewer',
  );
}

let marker;
try {
  marker = JSON.parse(readFileSync(MARKER, 'utf8'));
} catch {
  deny(`Push blocked: ${MARKER} is unreadable. Re-run the review and mark it again.`);
}

if (marker.commit !== head) {
  deny(
    `Push blocked: the review on record is for a different commit.\n\n` +
    `  reviewed: ${String(marker.commit).slice(0, 8)} by ${marker.reviewer ?? 'unknown'}` +
    `${marker.at ? ` at ${marker.at}` : ''}\n` +
    `  HEAD now: ${head.slice(0, 8)}\n\n` +
    'Commits made after a review are unreviewed, including an amend or a "one more ' +
    'small fix". Review the current diff, then:\n' +
    '  node .claude/hooks/mark-reviewed.mjs repo-reviewer',
  );
}

allow();
