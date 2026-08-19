# The review gate

A `PreToolUse` hook that blocks a push until the commit at HEAD has been
reviewed. It exists because commit `56bf5be` pushed three files that were never
in it, and nobody noticed until a fresh clone would not build.

**These files are the source of truth. They are not loaded from here.** The hook
runs from `~/.claude/hooks/`, wired in `~/.claude/settings.json`, because that is
user-level configuration and applies to every repository regardless of where a
session is rooted. This copy exists so the gate survives a machine rebuild, and
so its reasoning is reviewable in the same place as everything it protects.

It deliberately does **not** live in this repo's `.claude/settings.json`. It did,
once, and never ran: project settings load only for a session whose project root
is that project, and this one is usually opened from the home directory. Three
pushes went out unreviewed while the gate appeared to be installed — a worse
failure than having none, because a gate that is believed stops anyone checking.

## Install

```bash
mkdir -p ~/.claude/hooks
cp tools/review-gate/*.mjs ~/.claude/hooks/
```

Then merge this into `~/.claude/settings.json`, keeping whatever is already
there:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/hooks/review-gate.mjs\" || exit 2",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Settings are read at startup, so restart Claude Code afterwards. Edits to the
script itself take effect immediately — it is re-executed per tool call.

The `|| exit 2` matters: a denial is structured JSON on stdout with exit 0, so
that clause never fires on a normal refusal. It fires only when node cannot run
the script at all — a missing file, a syntax error — turning a silent no-op into
a blocking error. That is the one failure the script's own try/catch cannot
cover.

## Use

```
build  →  verify  →  commit  →  review  →  mark  →  push
```

```bash
node ~/.claude/hooks/mark-reviewed.mjs repo-reviewer sensitive-data-guard
```

The marker records a commit, so committing again makes it stale and re-arms the
gate. That is the intent: an amend and a "one more small fix" are both
unreviewed code.

Opt a repository out with `.claude/review-gate-off`. Note that file can itself
be committed, which would disable the gate for every clone — a legitimate act,
but one worth reviewing like any other.

## What it does not cover

- Pushes typed into a terminal. It sees only Claude Code's shell tools.
- A push buried inside a script the model merely invokes, or inside a heredoc or
  quoted string — those are stripped before matching, so that writing
  documentation about pushing is not mistaken for doing it.
- Anything able to write files, which can create the marker without a review.

It stops the accident, not a determined bypass. Where it *can* see a push but
cannot work out which repository the push targets, it refuses rather than
guessing: every phrasing it could not read would otherwise be a way past it.
