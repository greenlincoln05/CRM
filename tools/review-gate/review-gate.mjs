#!/usr/bin/env node
/**
 * Global review gate: blocks a push until the commit at HEAD has been reviewed.
 *
 * Installed in user settings, so it applies to every repository rather than to
 * one project. That is the difference from the per-repo version this grew out
 * of: it cannot resolve the repository from its own location on disk, because
 * its own location is now ~/.claude. It works out which repository the push is
 * aimed at from the command itself.
 *
 * How it clears, in whichever repo the push is for:
 *   node <this directory>/mark-reviewed.mjs <reviewer>
 *
 * How a repository opts out entirely: create `.claude/review-gate-off` in it.
 * A gate with no escape hatch gets switched off wholesale the first time it is
 * inconvenient, and then it is protecting nothing anywhere.
 *
 * ── Where it stops ──────────────────────────────────────────────────────────
 *
 * It sees only what Claude Code runs through its shell tools. A push typed
 * into a terminal, or one buried inside a script the model merely invokes, is
 * untouched. And the marker is an ordinary file, so anything that can write
 * files can clear it without a review. This stops the accident — the
 * end-of-session "just push it" — not a determined bypass.
 *
 * What it will NOT do is fail quietly. If a push is present and the target
 * repository cannot be worked out, that is a refusal, not a shrug: every
 * phrasing the parser does not understand would otherwise be a free push, and
 * a gate believed to be working while it waves things through is worse than no
 * gate at all. That is the exact failure this file was written to end.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SELF = dirname(fileURLToPath(import.meta.url));
const MARK = join(SELF, 'mark-reviewed.mjs');

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

/**
 * Git Bash hands out POSIX paths — `/c/Users/...` — and this runs under Windows
 * node, where `resolve()` turns that into `C:\c\Users\...`, which does not
 * exist. WSL and Cygwin have their own prefixes. Translate them all back.
 */
function toNativePath(p) {
  if (p.startsWith('~')) return join(homedir(), p.slice(1));
  const m = p.match(/^\/(?:cygdrive\/|mnt\/)?([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

/**
 * Every directory this command might push from.
 *
 * All of them, not the first: a command that inspects one repository and
 * pushes another would otherwise be judged against the wrong marker, which
 * makes any repo with a fresh marker a skeleton key for every other one. cwd
 * is always included, never as a replacement.
 */
function candidateDirs(command) {
  const dirs = [];
  const add = (raw) => {
    if (!raw) return;
    const cleaned = raw.replace(/^["']|["']$/g, '');
    // A path we cannot expand is a path we must not silently skip; leaving it
    // unresolved makes the "no repo found" refusal fire, which is correct.
    if (/[$`]/.test(cleaned)) return;
    try { dirs.push(resolve(process.cwd(), toNativePath(cleaned))); } catch { /* ignore */ }
  };

  // cd / pushd / PowerShell's Set-Location and Push-Location, every occurrence.
  for (const m of command.matchAll(
    /\b(?:cd|pushd|Set-Location|Push-Location|sl)\s+("[^"]+"|'[^']+'|[^\s;|&]+)/gi)) {
    add(m[1]);
  }
  // git -C <path>, wherever the flag sits among git's own options.
  for (const m of command.matchAll(/\bgit\b[^\n;|&]*?\s-C\s+("[^"]+"|'[^']+'|\S+)/gi)) {
    add(m[1]);
  }

  dirs.push(process.cwd());
  return dirs;
}

/**
 * Distinct repository roots among the candidates.
 *
 * Note the ENOENT trap: `execFileSync` raises it both when the binary is
 * missing AND when `cwd` does not exist, so the two cannot be told apart at the
 * call site. A candidate that is merely a path we guessed wrong would otherwise
 * be reported as "git is not installed" and block everything. So: skip
 * directories that do not exist, and establish git's availability separately,
 * once, where the answer is unambiguous.
 */
function gitIsAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function reposFor(command) {
  const found = new Set();
  for (const dir of candidateDirs(command)) {
    if (!existsSync(dir)) continue;
    try {
      found.add(execFileSync('git', ['rev-parse', '--show-toplevel'],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch {
      // Not a repository. Try the next candidate.
    }
  }
  if (found.size === 0 && !gitIsAvailable()) {
    deny(
      'Push blocked: the review gate could not run git, so nothing was ' +
      'verified. Check that git is on PATH for hook processes.',
    );
  }
  return [...found];
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    allow();
  }

  if (input?.tool_name !== 'Bash' && input?.tool_name !== 'PowerShell') allow();

  const rawCommand = String(input?.tool_input?.command ?? '');

  // Strip what is DATA rather than command, before looking for a push:
  //
  //   - heredoc bodies, so writing a file that documents `git push` is not
  //     mistaken for running one. This is not hypothetical; it blocked the
  //     commit that wrote this comment.
  //   - quoted strings, so `git commit -m "fix the push handler"` is not
  //     mistaken for one either.
  //
  // Both cuts are safe in the direction that matters: a real push written
  // inside a quoted string or a heredoc is a push the gate cannot see anyway,
  // and is covered by the honest-limits note at the top of this file.
  const command = rawCommand
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, ' ')
    .replace(/'[^']*'|"[^"]*"/g, ' ');

  const pushes = command.match(/\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*/gi) ?? [];
  if (pushes.length === 0) allow();

  // Allowed only if EVERY push in the chain is a dry run. Testing the whole
  // line would let `git push --dry-run && git push origin main` through.
  if (pushes.every((seg) => /--dry-run\b|(?:^|\s)-n(?:\s|$)/.test(seg))) allow();

  const repos = reposFor(rawCommand);

  const howTo = (repo) =>
    `  node "${MARK}" repo-reviewer\n\n` +
    'If this repository should not be gated at all, create this file:\n' +
    `  ${repo ? resolve(repo, '.claude/review-gate-off') : '<repo>/.claude/review-gate-off'}`;

  if (repos.length === 0) {
    deny(
      'Push blocked: this looks like a push, but the gate could not work out ' +
      'which repository it targets, so it could not check whether that ' +
      'repository has been reviewed.\n\n' +
      `  ${pushes[0].trim()}\n\n` +
      'Refusing rather than guessing — a phrasing the gate cannot read would ' +
      'otherwise be a way past it. Run the push from inside the repository, or ' +
      'name it with `git -C <path> push`.',
    );
  }

  // Every distinct repository in play must pass. One clean marker elsewhere
  // must not vouch for a different repo's unreviewed commits.
  for (const repo of repos) {
    if (existsSync(resolve(repo, '.claude/review-gate-off'))) continue;

    const unverifiable = pushes.find((seg) =>
      /--all\b|--mirror\b|--tags\b/.test(seg));
    if (unverifiable) {
      deny(
        'Push blocked: this may send something other than HEAD, and the gate ' +
        'only verifies HEAD.\n\n' +
        `  ${unverifiable.trim()}\n\n` +
        'Push the reviewed commit on its own branch, or review and mark what ' +
        'this would actually send.',
      );
    }

    let head;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'],
        { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      continue; // no commits yet; nothing to have reviewed
    }

    const marker = resolve(repo, '.claude/review-state.json');

    if (!existsSync(marker)) {
      deny(
        `Push blocked: no review on record for ${repo}.\n\n` +
        'Review the change before it reaches the remote — and add a security ' +
        'reviewer too if it touches credentials, personal data, or anything ' +
        "governed by this repository's own rules.\n\n" + howTo(repo),
      );
    }

    let record;
    try {
      record = JSON.parse(readFileSync(marker, 'utf8'));
    } catch {
      deny(`Push blocked: ${marker} is unreadable. Review again and re-mark.\n\n${howTo(repo)}`);
    }

    if (record.commit !== head) {
      deny(
        'Push blocked: the review on record is for a different commit.\n\n' +
        `  repo:     ${repo}\n` +
        `  reviewed: ${String(record.commit).slice(0, 8)} by ${record.reviewer ?? 'unknown'}` +
        `${record.at ? ` at ${record.at}` : ''}\n` +
        `  HEAD now: ${head.slice(0, 8)}\n\n` +
        'Commits made after a review are unreviewed, including an amend or a ' +
        '"one more small fix".\n\n' + howTo(repo),
      );
    }
  }

  allow();
}

try {
  main();
} catch (err) {
  // Fail CLOSED. A gate that silently stops working is worse than no gate,
  // because it is believed.
  deny(
    'Push blocked: the review gate itself failed, so nothing was verified.\n\n' +
    `  ${err?.message ?? err}\n\n` +
    `Fix ${fileURLToPath(import.meta.url)} before pushing.`,
  );
}
