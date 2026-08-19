#!/usr/bin/env node
/**
 * Blocks a push until repo-reviewer has reviewed the commit at HEAD.
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
 * What it actually checks, precisely: that HEAD is the reviewed commit. It does
 * NOT resolve refspecs, so pushes that could send something other than HEAD —
 * `--all`, `--mirror`, `--tags`, or an explicit `src:dst` — are refused outright
 * rather than waved through on a check that does not cover them.
 *
 * Honest limit: the marker is an ordinary file, and any agent with Write can
 * create it. This stops the accident, not a determined bypass. The record is a
 * reviewer's name, not proof.
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

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    allow(); // no readable payload: not our business
  }

  // Both shell tools. This machine's primary is PowerShell, and a gate that only
  // watches Bash would miss every push issued through the other one.
  if (input?.tool_name !== 'Bash' && input?.tool_name !== 'PowerShell') allow();

  const raw = String(input?.tool_input?.command ?? '');

  // Strip quoted strings first, so `git commit -m "fix the push handler"` is not
  // mistaken for a push. Commit messages in this repo mention pushing constantly.
  const command = raw.replace(/'[^']*'|"[^"]*"/g, ' ');

  // Every push-ish segment, case-insensitively (Windows resolves `Git` fine).
  // Segments split on ; | & so each command in a chain is judged on its own.
  const pushes = command.match(/\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*/gi) ?? [];
  if (pushes.length === 0) allow();

  // Allowed only if EVERY push in the chain is a dry run. Testing the whole line
  // would let `git push --dry-run && git push origin main` through — which is
  // exactly the phrasing a careful person uses.
  if (pushes.every((seg) => /--dry-run\b/.test(seg))) allow();

  const unverifiable = pushes.find((seg) =>
    /--all\b|--mirror\b|--tags\b|\S+:\S+/.test(seg));
  if (unverifiable) {
    deny(
      'Push blocked: this push may send something other than HEAD, and the gate ' +
      'only verifies HEAD.\n\n' +
      `  ${unverifiable.trim()}\n\n` +
      'Push the reviewed commit on its own branch, or review and mark whatever ' +
      'this would actually send.',
    );
  }

  let head;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    allow(); // no HEAD yet, or not a repo — nothing to have reviewed
  }

  if (!existsSync(MARKER)) {
    deny(
      'Push blocked: no review on record.\n\n' +
      'Every code change goes through repo-reviewer before it reaches the remote — ' +
      'and sensitive-data-guard too if it touches gate codes, access notes, photos, ' +
      'or PII.\n\n' +
      'When the review is done and its findings are fixed or consciously accepted:\n' +
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
      'Push blocked: the review on record is for a different commit.\n\n' +
      `  reviewed: ${String(marker.commit).slice(0, 8)} by ${marker.reviewer ?? 'unknown'}` +
      `${marker.at ? ` at ${marker.at}` : ''}\n` +
      `  HEAD now: ${head.slice(0, 8)}\n\n` +
      'Commits made after a review are unreviewed, including an amend or a "one more ' +
      'small fix". Review the current diff, then:\n' +
      '  node .claude/hooks/mark-reviewed.mjs repo-reviewer',
    );
  }

  allow();
}

try {
  main();
} catch (err) {
  // Fail CLOSED. A gate that silently stops working is how 56bf5be happened:
  // everything looked fine and nothing was actually being checked.
  deny(
    'Push blocked: the review gate itself failed, so nothing was verified.\n\n' +
    `  ${err?.message ?? err}\n\n` +
    'Fix .claude/hooks/review-gate.mjs before pushing.',
  );
}
