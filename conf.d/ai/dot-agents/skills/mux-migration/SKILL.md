---
name: mux-migration
description: Plan and perform one-shot moves of live pi coding-agent sessions and terminals between Orca, Paseo, herdr-core (hc), herdr, and Rex. Use when the user asks to migrate/move/relocate all open pi sessions, close one multiplexer and reopen them in another, rebuild a herdr-core or herdr-app layout, find which Orca/herdr/Rex/hc terminal owns a pi .jsonl session, or asks why a terminal is missing from herdr-app/hc. This is migration, not continuous sync.
compatibility: Requires Python 3.11+, pi, and whichever of hc, herdr, rex, paseo, and the Orca CLI are installed. On Linux use the Orca CLI path from ~/.config/orca/cli/bin/orca (or ORCA_CLI_COMMAND), never a bare `orca`, which is the GNOME screen reader.
---

# Multiplexer migrations

A migration is a **move**, not a sync. The pi session `.jsonl` is the state; a terminal
runtime is only the process that currently owns it. The job is to stop the old owner,
start one new owner on the same file, and verify that exactly one process remains.

This skill covers **Orca**, **Paseo**, **herdr-core (hc)**, **herdr**, and **Rex**. They have different
models, and only hc can be attached to as a viewer, but the pi-session rule is the same
everywhere.

## Invocation

There is no separate prompt template: this skill is the whole entry point. Ask in natural
language or run `/skill:mux-migration`. If the request names a source, destination, or
scope (a session id/file or `--all`), use it; otherwise inventory first and ask before
moving anything. The default destination is chosen after inventory, the default scope is
all live pi sessions, and the current session is always excluded.

## Start here

1. Inventory: `python3 scripts/mux_inventory.py`
    - A `*` marks the pi process running the current session. **Never move it** unless the
      user explicitly arranges for another agent to do the move.
    - `FILE` is `ok`, `pending` (pi has not written it yet), or `unknown` (Orca/Rex without
      a registry match).
    - `DUP` means more than one process owns one session. Resolve it before moving.
2. Read `references/runtimes.md` for the source and destination you will use.
3. Plan a dry run:
    - `python3 scripts/mux_move.py --from hc --to rex --all`
    - `python3 scripts/mux_move.py --from orca --to hc --session <id-or-file>`
    - `python3 scripts/mux_move.py --from rex --to hc --all --allow-pending`
4. Inspect the plan; confirm with the user; only then add `--apply`.
5. If the destination is hc and the user wants to see the terminals in the herdr-app
   layout, run `python3 scripts/hc_place.py` first, then `--apply`. This is a separate
   step because hc terminals exist even when the app hides them.
6. Close old shells, empty Rex sessions, and finished hc terminals only after the pi
   sessions are verified.

For Orca, start with `python3 scripts/orca_match.py` if the inventory says `unknown`.
Orca does not expose the pi session file; the registry or a screen/content match has to
supply it. Do not guess a session file when two tabs share a folder.

## The invariant

- **One live pi process per `.jsonl`, ever.** pi has no file lock and two writers corrupt
  the conversation. Stop every live owner before starting the destination.
- **Stop old before start.** Starting the destination first creates a short dual-writer
  window. The session file is safe if a destination start fails; retry from the file.
- **Wait for idle.** The pi TUI shows `INSERT` at its prompt; herdr reports `idle`. A
  working/blocked agent can lose an in-flight turn. `--force` is for an explicit user
  decision, not a convenience.
- **Do not move the current session.** The process running the migration is a live owner.
  Use a separate pi/agent to move it, or leave it in place.
- **No adoption.** Orca, herdr, hc, and Rex cannot take over an existing PTY. "Migrate"
  always means restart `pi --session <file>`. Only hc terminals can be _viewed_ from
  elsewhere with `hc attach`; the hc terminal remains the owner.
- **Shells are not pi sessions.** They have no `.jsonl`; recreate a shell at the same cwd
  in the destination, then close the old shell. Scrollback is not preserved.
- **A pending file is a real session.** pi creates the `.jsonl` on its first turn. If the
  file is missing, use `--allow-pending`; the destination may create it. If the destination
  refuses a missing path, start a fresh pi there and say the old pending session was empty.

## Runtime model

| Runtime         | Topology                        | Unit for a pi                    | How to see it                                                                  | How to stop                                     |
| --------------- | ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| Orca            | worktree → tab → pane           | tab running pi                   | `orca terminal list --include-visual-layouts --json`, `terminal read --screen` | `orca terminal close --terminal <handle> --tab` |
| Paseo           | workspace → agent               | agent process / imported session | `paseo ls -a --json`, `~/.paseo/agents/*/*.json`                               | `paseo stop <id>`, `paseo archive <id> --force` |
| hc / herdr-core | flat terminals (no tabs/spaces) | terminal                         | `hc ls --json`, `hc get <addr> --json`                                         | `hc kill <addr>`                                |
| herdr           | workspace → tab → pane          | pane                             | `herdr api snapshot`                                                           | `herdr pane close <pane>`                       |
| Rex             | session → window → block        | block                            | `rex block ls -s <session> --json`, `rex block call ... process`               | `rex block close -s <session> <block>`          |

Mapping when rebuilding a layout:

- Orca tab ≈ herdr tab ≈ Rex window ≈ a project tab.
- Orca pane ≈ herdr pane ≈ Rex block ≈ hc terminal.
- One hc terminal is one process, not a tab. Put hc terminals in the herdr-app doc with
  `herdr.space` + `herdr.tab` labels when the user is looking at the app.
- A folder normally gets one Rex session and one herdr/hc space; tabs/windows are the
  terminals inside it.

## The move, step by step

1. **Inventory and group by session.** The same session can appear as an Orca tab and an
   hc terminal; group by `session_id` or `session_file`, not by title.
2. **Check live owners.** If there are two, the session is already in trouble. With the
   user's approval, stop both before starting the destination. Without approval, stop.
3. **Check idle** with the runtime's screen/status. Skip working agents unless forced.
4. **Stop the old owner(s).** Verify the pid is gone. Orca's close result may say
   `ptyKilled: false` but still close the tab; trust the pid and the tab list, not that field.
5. **Start the destination** with `pi --session <file>`, at the original cwd. Use the
   runtime adapter in `muxlib` or the commands in `references/runtimes.md`.
6. **Verify:** the destination's foreground is pi, the session file exists, and the old pid
   is gone. For hc, `hc get` should show the pi foreground and the `sync.pi` label. For Rex,
   `rex block call ... process` should show `argv0: pi`. For herdr, the pane's
   `agent_session.value` should be the same file. For Orca, `agentIdentity` should be pi and
   the tab should be the new one.
7. **Place hc terminals in the app** if needed: `hc_place.py`. hc `Devices`/app UIs hide
   unlabeled terminals; the app doc is `herdr-app` and placement is by `herdr.space`/`herdr.tab`.
   The mover preserves the source title in the `sync.title` label; `hc_place.py` uses it as
   the app tab name, and `mux_inventory.py` reads it back so a later hc→Orca move restores
   the exact title with `orca terminal create --title`.
8. **Clean up** old shells, empty Rex sessions, and finished hc terminals after verification.

## Destination quick commands

### hc

```sh
hc run --bg --keep --no-parent --name mise-t4b --cwd ~/.config/mise \
  --label sync.pi=/path/to/session.jsonl --json \
  -- pi --session /path/to/session.jsonl
```

`--name` is restricted to `[a-z0-9-_]{1,32}`. `--json` is an hc option, so it must come
before `--`; anything after `--` is passed to pi. hc terminals are the only ones that can
be attached to with `hc attach <addr>` (detach with `ctrl+\`).

The mover derives the hc `--name` from the source title with `safe_name` (for example
`fnox / mise audit` → `fnox-mise-audit`) and adds `--label sync.title=<original title>`.
That label is the authoritative display name for the herdr-app tab and for the return
move, so do not drop it when creating hc terminals by hand.

### Rex

```sh
rex new mise -c ~/.config/mise --window 'mise · t4b' --interactive --json \
  -- pi --session /path/to/session.jsonl
# later windows in the same session:
rex window new -s mise 'mise · t4d' -c ~/.config/mise --interactive --json \
  -- pi --session /path/to/other.jsonl
```

A Rex **session** is a workspace, a **window** is a tab, and a **block** is a pane.
`rex block rename`/`rex block close` take the block positionally; this CLI has no `-b`
option for those commands. `rex new` creates the session; `rex window new` adds a tab.

### Orca

```sh
~/.config/orca/cli/bin/orca terminal create --worktree path:/abs/folder \
  --title 'mise · 2' --command "pi --session '/path/to/session.jsonl'" --json
```

Orca only creates in a known worktree. Do not call `orca repo add` unless the user wants a
new sidebar entry. Orca's CLI on Linux is not `/usr/bin/orca` (GNOME screen reader); use
`ORCA_CLI_COMMAND` or `~/.config/orca/cli/bin/orca`.

**Orca Chat UI is not a separate owner when the tab is terminal-backed:** it is a normal
Orca terminal rendered as chat, so the mover handles it. A **structured/native chat** tab
(created by Orca Chat UI or `orca agent launch`, process `orca-provider-exec ... pi --mode
rpc`) is inventoried as `orca-chat`; `mux_inventory.py` resolves its `.jsonl` from the
running pi's parent `--session` argument, Orca's `agent-hooks/last-status.db` transcript
path, or by matching `orca agent read` against the session files. `mux_move.py --allow-native-chat` stops that RPC pi, moves the session out,
and closes the Orca chat tab through the app's `agentSession.close` runtime RPC — the
same operation the not-yet-shipped CLI `chat close` will call (upstream #37143/#39918).
If the runtime RPC is unavailable it falls back to stopping the pi and tells you the tab
is still open; do not use `--allow-plain` for native chats. Migrating **to** Orca uses a
normal terminal by default, or Chat UI with `--orca-native-chat`. That path does what the
desktop `/resume` command does: it calls `agentSession.create` with `resumeFrom`, and when
that returns `conversationHeldElsewhere` it calls `agentSession.reveal` on the owner chat
instead of creating a duplicate. A dormant native chat tab left by an older/manual stop
therefore reopens rather than blocking the move. The native-chat create RPC is not exposed
by the Orca CLI; the skill talks to the app's runtime socket directly. Pi native-chat
`forkFrom` is still refused (`structured_agent_session_unsupported`).

### Paseo

`paseo import <pi-session-id> --provider pi --cwd <cwd>` adopts a session into Paseo as
an agent. Import creates an idle agent and does not start a second pi immediately. Stop a
Paseo source with `paseo stop <id>` then `paseo archive <id> --force`; verify the pi pid
is gone. Paseo agent records live under `~/.paseo/agents/<mangled-cwd>/<id>.json`; the
`persistence.nativeHandle` is the `.jsonl` and `PASEO_AGENT_ID` identifies the process.
`mux_move.py --to paseo` imports; `--from paseo` archives the source.

### herdr

```sh
herdr tab create --workspace <workspace-id> --label 'mise · 2' \
  --cwd /abs/folder --no-focus
# find the new pane in herdr api snapshot; then:
herdr agent start 'mise · 2' --kind pi --pane <pane-id> -- --session /path/to/session.jsonl
```

The new pane must be at an interactive shell prompt (a new tab is). A pane running
`hc attach <addr>` is a viewer, not a pi owner; closing it detaches, while closing a pi
pane kills the pi.

## The scripts

- `scripts/mux_inventory.py` — read-only inventory; `--json`, `--all`, `--runtime`,
  `--idle`. It uses the session-home registry when present, then direct `/proc` env and
  each runtime CLI. `unknown` means the runtime did not expose a session file.
- `scripts/mux_move.py` — one-shot mover; dry-run by default; `--apply`, `--all`,
  `--session`, `--force`, `--allow-pending`, `--allow-native-chat`, `--add-repo`,
  `--orca-native-chat`, `--rex-session`, `--herdr-workspace`. It stops every owner before
  starting. Native Orca chats need `--allow-native-chat`; the runtime RPC closes their tab
  after the stop. `--orca-native-chat` resumes the destination in Chat UI, revealing an
  existing owner chat when Orca reports `conversationHeldElsewhere`. Paseo is selected
  with `--from paseo` / `--to paseo`; it imports by pi session id.
- `scripts/orca_match.py` — read-only screen/content matcher for Orca pi tabs that are not
  in the registry. It filters candidates by cwd and ranks 48-character screen windows.
- `scripts/hc_place.py` — places hc terminals in the `herdr-app` doc by folder, reuses
  spaces, merges duplicate spaces for the same folder, and sets `herdr.space`/`herdr.tab`/
  `where`. Dry-run by default; `--apply`, `--terminal`, `--folder`, `--socket`.

These scripts are helpers, not a daemon. Inspect a dry run before applying; the runtimes
change and the CLIs are the source of truth.

## Common failures

- **`hc ls` has the terminal but herdr-app shows nothing.** The terminal lacks
  `herdr.space`/`herdr.tab`, or its space/tab is not in the `herdr-app` doc. Run
  `hc_place.py`. If there are two spaces with the same folder, the app shows only one;
  `hc_place.py` merges them. The app doc is shared; `doc.set` needs a version and may
  conflict with a running client, so retry.
- **Two tabs in the mise folder are "unrelated".** A second space was created for the same
  folder instead of reusing the existing one. Merge the duplicate into the folder's first
  space; do not create another `mise` space.
- **The hc tab shows a sanitized name instead of the original title.** The terminal is
  missing `sync.title`, or `hc_place.py` ran before the label was set. Add
  `hc label <addr> sync.title='<original title>'` and rerun `hc_place.py --apply`; the
  return move reads that label and restores the exact Orca title.
- **An Orca native chat shows `orca-chat` with no terminal handle.** Move it out with
  `mux_move.py --allow-native-chat`; the skill stops the RPC pi and closes the Orca chat
  tab through `agentSession.close`. If the RPC is unavailable, close any remaining tab in
  Orca. To Orca, use `--orca-native-chat` for Chat UI (it reveals an existing owner chat)
  or omit it for a terminal.
- **The session file is not the one in `sync.pi`.** A resumed/forked pi updates the
  `wake` label in hc; prefer `wake.session_file` over the older `sync.pi` label.
- **Orca handle is stale.** Handles are runtime-scoped; `tabId` is durable. Re-list and
  close by the current handle; never match on `terminal.title`.
- **Orca has no session file.** Use the registry, `orca_match.py`, or start a new pi. Do not
  resume a guessed session from a different tab in the same folder.
- **Rex has no session file.** The registry is the reliable source. `rex block inspect`
  does not expose the command. If the registry is gone, ask the running pi `/where` (if
  the session-home extension is loaded) or start a new session and say so.
- **A Rex session is empty after moving its last pi.** `rex block close` removes the block;
  empty sessions remain listed. Close them with `rex session kill` when the user agrees.
- **The current session appears in the plan.** Do not move it. Use another agent.

## References

- `references/runtimes.md` — exact commands, JSON shapes, socket/env issues, and caveats per
  runtime.
- `references/recipes.md` — step-by-step Rex↔hc, Orca→Rex, herdr→hc, all→hc/Rex, plus app
  placement and cleanup.
