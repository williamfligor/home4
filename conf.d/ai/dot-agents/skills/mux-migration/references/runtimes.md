# Runtime notes

Read this before moving a live pi session. The CLIs are the source of truth; this file
records the parts that are easy to get wrong.

## Common rules

- The pi session file is `~/.pi/agent/sessions/<flattened-cwd>/<timestamp>_<uuid>.jsonl`.
  `pi --session <path>` resumes it. `--continue`/`--resume`/`--fork` also accept a session
  id or path; `--no-session` has no file and cannot be migrated.
- pi creates the file lazily on the first turn. A live pi with no file is **pending**, not
  dead.
- pi has no lock. One writer per file. Stop every live owner before starting the new one.
- A working pi shows a spinner/`esc interrupt`; an idle one shows `INSERT`. `ctx.isIdle()`
  is the in-process check; from outside, use the screen/status.
- The current agent is an owner too. Never migrate the process that is running the
  migration. The inventory marks it with `*`.
- Do not dump the whole environment: Orca environments can contain `ORCA_AGENT_HOOK_TOKEN`
  and provider keys. Only read the identity variables listed below.
- The session-home registry (`$XDG_STATE_HOME/pi/session-homes/<pid>.json`, usually
  `~/.local/state/pi/session-homes/`) is a useful hint but is optional and can be stale or
  absent. Always cross-check a live pid and the runtime CLI.

---

## Orca

**CLI:** `ORCA_CLI_COMMAND`, else `~/.config/orca/cli/bin/orca`, else `orca-ide`.
Never use bare `orca` on Linux: `/usr/bin/orca` is the GNOME screen reader and will start
speech. The CLI is the Orca IDE's local control socket; handles belong to one runtime.

**Model:** worktrees (or folder workspaces) → terminal tabs → panes. A terminal row has
`handle`, `tabId`, `leafId`, `worktreeId`, `worktreePath`, `title`, `agentIdentity`,
`connected`, `writable`. `tabId` is durable; `handle` is runtime-scoped and goes stale
after an Orca restart (`terminal_handle_stale`). Never match a terminal by `title`; it is
the running program's title.

```sh
ORCA=~/.config/orca/cli/bin/orca
$ORCA terminal list --include-visual-layouts --json
$ORCA terminal read --terminal <handle> --screen --json
$ORCA terminal create --worktree path:/abs/folder --title 'name' \
  --command "pi --session '/path/session.jsonl'" --json
$ORCA terminal send --terminal <handle> --text "hc attach t7" --enter
$ORCA terminal close --terminal <handle> --tab --json
$ORCA worktree ps --json
$ORCA repo add --path /abs/folder --json        # visible sidebar change
```

**Session files:** Orca exposes only `agentIdentity: "pi"`; it never exposes the `.jsonl`.
Use the session-home registry first. Otherwise use `orca_match.py` (screen windows versus
session-file tails, filtered by the tab's worktree), or `orca worktree ps` prompts as a
hint. A tab whose terminal is a shell can still be running pi; the direct pi process env
has `ORCA_TAB_ID` and `ORCA_TERMINAL_HANDLE`. Do not resume a guessed session from another
tab in the same folder.

**Closing:** `terminal close --terminal <handle> --tab` closes the whole tab. The JSON may
report `ptyKilled: false` even when the tab and process close; verify the pid and the
terminal list, not that field. Closing a tab kills the pi; only the `.jsonl` remains.

**Creating:** `--worktree path:<abs folder>` only works if Orca already knows the folder as
a worktree. Folder workspaces use a `folder:<uuid>` worktree id; resolve its path through
`worktree ps` if `worktreePath` is empty. `--command` is typed into the login shell, so the
shell's PATH applies. Do not run `repo add` without the user's consent.

**Current/active:** `ORCA_TAB_ID`, `ORCA_TERMINAL_HANDLE`, `ORCA_PANE_KEY`,
`ORCA_WORKTREE_ID`, `ORCA_WORKSPACE_ID`. A pi launched inside an Orca terminal inherits
them, as can children of an hc/herdr core launched from Orca. The innermost runtime wins:
Rex > hc > herdr > Orca when reading a process env.

**Chat UI:** a terminal tab switched to Chat UI is still a terminal and moves normally.
A structured chat tab (`orca-provider-exec` + `pi --mode rpc`) is inventoried as
`orca-chat`. The inventory resolves its `.jsonl` from the pi parent's `--session` argument,
Orca's `agent-hooks/last-status.db` transcript path, or by matching `orca agent read` text
against session files. Terminal pi tabs started as bare `pi` rely on the status DB. `mux_move.py
--allow-native-chat` stops the RPC pi, moves the `.jsonl`, and calls the app's
`agentSession.close` runtime RPC to retire the chat tab. The CLI still lacks `chat close`
(PR #39918), so if the runtime RPC is unavailable the tab is left open and must be closed
in the UI. `terminal close` cannot close a structured chat; `--allow-plain` is not a
substitute. Migrating **to** Orca uses a terminal by default. With
`--orca-native-chat`, `mux_move.py` calls the app's `agentSession.create` with
`resumeFrom`; if the host refuses with `conversationHeldElsewhere`, it calls
`agentSession.reveal` for the owner chat, matching the desktop `/resume` command. Pi
native-chat `forkFrom` is refused as `structured_agent_session_unsupported`.

---

## Paseo

Paseo is an agent orchestrator, not a terminal multiplexer. Its unit is an **agent**, not
a tab.

- List: `paseo ls -a --json`; inspect: `paseo inspect <agent-id> --json`.
- The authoritative file is `~/.paseo/agents/<mangled-cwd>/<agent-id>.json` (or
  `$PASEO_HOME/agents`). `persistence.nativeHandle` is the pi `.jsonl`,
  `persistence.sessionId`/`runtimeInfo.sessionId` is the provider id, and `cwd` is the
  workspace directory.
- A running agent's pi process carries `PASEO_AGENT_ID`, `PASEO_WORKSPACE_ID` and
  `PASEO_AGENT_CWD`; its parent is the Paseo daemon, not a shell.
- Destination: `paseo import <pi-session-id> --provider pi --cwd <cwd>` creates an idle
  agent that adopts the existing session; it does not start a second pi immediately.
- Source stop: `paseo stop <id>` (interrupt, no-op if idle), then
  `paseo archive <id> --force`; verify the pi pid is gone. Archive is a soft delete;
  `paseo delete <id>` removes the record if the user wants it gone.
- `paseo terminal` is a shell terminal inside a workspace, not a pi session owner.

## herdr-core (hc)

**CLI:** `hc` (shim or binary). The core socket is `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`
or `HC_SOCKET`; `HC_SESSION` selects a core, default `default`. The `hc` CLI uses the same
env; if a shell points at another core, `hc ls` will look empty.

**Model:** flat terminals only. hc has no tabs/spaces and no focus. A terminal has
`address` (t4j), `name`, `cwd`, `state`, `keep`, `labels`, `foreground`, `argv`, `pid`,
`identity`, `title`, `where`. `hc ls` shows live terminals; `hc ls --all` also shows
finished ones (`hidden_finished`).

```sh
hc ls --json
hc get t4j --json
hc run --bg --keep --no-parent --name mise-t4b --cwd ~/.config/mise \
  --label sync.pi=/path/session.jsonl --json -- pi --session /path/session.jsonl
hc send t4j 'pi --session /path/session.jsonl'
hc keys t4j enter
hc kill t4j --json
hc keep t4j                 # keep after loss; --off disables
hc rm t4j                   # remove a finished terminal
hc read t4j                 # screen + history; --lines N
hc attach t4j               # ctrl+\ detaches; --observe read-only
hc label t4j from=rex sync.pi=/path/session.jsonl
hc connect                  # JSON-RPC over stdin/stdout
```

**Starting a pi:**

- Prefer `hc run --bg --keep --no-parent --name <name> --cwd <cwd> --label sync.pi=<file> --json -- pi --session <file>`.
- `--name` is `[a-z0-9-_]{1,32}`; no Unicode or spaces. The script's `safe_name` handles it.
- The mover preserves the source title: `muxlib.start_hc` derives the `--name` from it and
  adds `--label sync.title=<original title>`. `hc_place.py` uses that label as the app tab
  name, and `mux_inventory.py` prefers it when building the record, so the later hc→Orca
  move passes the exact title to `orca terminal create --title`.
- `--json` is an hc option; it must be before `--`. Anything after `--` goes to pi.
- The hc core may wrap the program with `herdr-wake shell`; the `foreground` becomes pi and
  the `wake` label records `session_id` and `session_file`. Prefer `wake.session_file` over
  an older `sync.pi` label: a resume/fork updates `wake`, not the migration label.
- A shell-first migration (`hc run` a shell, stop the source, then `hc send` the pi command)
  is also valid and avoids a short ownership gap; stop the source before `pi` starts in
  either style.

**HC as a viewer:** `hc attach <addr>` mirrors a terminal into any tty; multiple viewers
are allowed, and `ctrl+\` detaches without killing the hc terminal. This is the only
cross-runtime attach. Orca and herdr cannot be attached to.

**Labels and herdr-app:** hc labels are arbitrary `k=v`. herdr-app only draws a terminal
when it carries `herdr.space=<space id>` and `herdr.tab=<tab id>` naming entries in the
`herdr-app` document; unlabeled terminals stay hidden from the layout even though
`hc ls` sees them. `where` is display text such as `mise / t4b`. Use `hc_place.py`:

```sh
python3 scripts/hc_place.py             # dry run
python3 scripts/hc_place.py --apply
```

The app document lives in the hc core:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"doc.get","params":{"name":"herdr-app"}}' | hc connect
```

`doc.set` takes `{name, value, version}` and fails with `conflict` if the version is stale;
read-modify-write with retries. A space has `{id, name, folder, tabs[]}`. A tab has
`{id, name, root}` where root is a row/split with block nodes
`{id, type:"block", content:{terminal:"t4j"}}`. IDs are `sp`/`tb`/`p` + 32 hex.

**Duplicate spaces:** never create a second space for a folder. The app groups by folder
and shows one; the other terminals appear missing. Merge the tabs into the first space and
update the terminals' `herdr.space` labels. This was the "only two unrelated tabs in mise"
failure.

**Socket:** `HC_SOCKET` overrides; `HC_SESSION` selects another core; the app normally uses
the same default core as `hc`. If `hc ls` shows terminals but the app does not, confirm the
app's core and the placement labels.

---

## herdr

**CLI:** `herdr`. The TUI's default socket is `~/.config/herdr/herdr.sock`; a named session
uses `~/.config/herdr/sessions/<name>/herdr.sock`; `HERDR_SOCKET_PATH` overrides. The TUI
and hc have separate sockets; never confuse them.

**Model:** workspace → tab → pane. `herdr api snapshot` returns the authoritative topology:

```json
{
    "workspace_id": "w42",
    "tab_id": "w42:t1",
    "pane_id": "w42:p1",
    "agent": "pi",
    "agent_status": "idle",
    "agent_session": { "agent": "pi", "kind": "path", "value": "/path/session.jsonl" },
    "cwd": "/home/will",
    "terminal_title": "π - will"
}
```

A pane running `hc attach t7` is a viewer, not an agent. Closing a viewer pane detaches;
closing the owner pane kills the pi. A pane's agent session is the best session-file source.

```sh
herdr api snapshot
herdr workspace create --label misc --cwd /abs/folder --no-focus
herdr tab create --workspace w42 --label 'mise · 2' --cwd /abs/folder --no-focus
herdr pane split --pane w42:p1 --direction right --ratio 30 --cwd /abs/folder
herdr pane rename w42:p1 'label'          # no event; poll snapshot
herdr pane run w42:p1 pi --session /path/session.jsonl
herdr pane close w42:p1
herdr agent start 'mise · 2' --kind pi --pane w42:p1 -- --session /path/session.jsonl
herdr session list
```

`herdr tab create` does not print the new pane id; snapshot before/after and use the new
pane. `herdr agent start` requires the pane to be at an interactive shell prompt (a new tab
is) and waits for pi readiness. There is no adoption of an existing PTY. `pane rename` emits
no event; poll `session.snapshot`. `pane close` is the way to stop a pi owner.

**Env:** a pi in a real TUI pane exports `HERDR_ENV=1`, `HERDR_SOCKET_PATH`,
`HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`; a headless pane
driven from an Orca shell may export none. Use the snapshot, not only the env.

---

## Rex

**CLI:** `rex`; the server is local (autostart by default). `rex ls --json` lists sessions;
a session contains windows (tabs), which contain blocks (panes).

```sh
rex ls --json
rex window ls -s <session> --json
rex block ls -s <session> --json
rex new mise -c /abs/folder --window 'mise · t4b' --interactive --json \
  -- pi --session /path/session.jsonl
rex window new -s mise 'mise · t4d' -c /abs/folder --interactive --json \
  -- pi --session /path/other.jsonl
rex split -s mise -b <block> --split=right --ratio 30 --json -- pi --session ...
rex block call -s mise -b <block> process
rex capture -s mise -b <block> --trim
rex send -s mise -b <block> 'ls'
rex send-key -s mise -b <block> enter
rex block rename -s mise <block> 'label'    # block is positional; no -b
rex block close -s mise <block>             # block is positional; no -b
rex session kill mise
rex skill setup
```

- `rex new` creates the session and its first window; `rex window new` adds a tab; `rex run`
  adds a tab; `rex split` adds a pane. Use `--interactive` so the shell reads `.zshrc` and
  finds pi.
- `--json` before `--`. The JSON gives `session_id`, `window_id`, `block_ids`; save them.
- `rex block rename` and `rex block close` do **not** accept `-b` in current builds; pass
  the block ID positionally after `-s`. `rex block call` does accept `-b`.
- A block is a terminal. `block call process` returns `foreground.argv0`/`pid`/`cwd`;
  `argv0: pi` is the verification.
- `REX_SESSION`/`REX_BLOCK` identify a pi's home. Rex sets them; there is no shell
  environment variable for the session file.
- There is **no importer or PTY adoption**. The onboarding block is a client-drawn
  walkthrough; it does not move terminals. Migrate by creating sessions/windows and running
  `pi --session`.
- `rex skill setup` installs the Rex skill for Pi (`~/.agents/skills/rex`); Pi has no hook,
  but the skill uses the inherited `REX_*` variables.
- Closing the last block leaves an empty session; `rex ls` may still show it. Close empty
  sessions explicitly if the user wants them gone.
- The Rex app/client is separate from the server; new sessions/windows appear in connected
  clients, but a client may need a reload.

---

## pi and the session-home registry

Useful pi flags:

```sh
pi --session /path/session.jsonl
pi --continue
pi --resume <id-or-path>
pi --fork <id-or-path>
pi --session-id <uuid>
pi --no-session          # cannot be migrated: no file
```

The session-home extension (if installed) writes one file per process:

```json
{
    "schema": 1,
    "session": { "id": "...", "file": "/path.jsonl", "cwd": "...", "name": null, "mode": "tui" },
    "process": { "pid": 123, "boot": "...", "startTicks": 123, "startedAt": "..." },
    "home": { "kind": "hc", "hc": { "HC_TERMINAL_ID": "t4j", "HC_TERMINAL_SOCKET": "..." } },
    "term": { "TERM_PROGRAM": "..." }
}
```

It is keyed by pid, deleted on shutdown, and only covers processes started after it loaded.
It may be absent or stale. Its `home.kind` can be `hc`, `herdr`, `orca`, `rex`, or `plain`.
Do not assume a record means the process is still alive; check the pid. Do not read the
whole environment; the extension uses an allowlist because Orca environments can carry
tokens.

## herdr-app placement in one page

1. The app reads the `herdr-app` document from the hc core.
2. A terminal is placed only by `herdr.space` + `herdr.tab` labels pointing at a space/tab in
   that document; `where` is display text.
3. The app hides unlabeled terminals; `hc ls` still shows them. `hc_place.py` fixes this.
4. One space per folder. If two spaces share a folder, merge them; the app shows one.
5. `doc.set` is optimistic-concurrency: read the version, merge, write, retry on conflict.
6. The app and hc CLI can use different cores; check `HC_SESSION`/`HC_SOCKET` if the app is
   empty but `hc ls` has terminals.

---

## Command/path summary

| What                 | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| Orca CLI             | `$ORCA_CLI_COMMAND` or `~/.config/orca/cli/bin/orca` or `orca-ide`   |
| Orca socket          | `~/.config/orca/daemon/daemon-v54.sock` (unsupported; do not script) |
| hc CLI               | `hc`; `HC_SOCKET` / `HC_SESSION`                                     |
| hc default socket    | `$XDG_RUNTIME_DIR/herdr-core/default.sock`                           |
| herdr CLI            | `herdr`; `HERDR_SOCKET_PATH`                                         |
| herdr default socket | `~/.config/herdr/herdr.sock`                                         |
| Rex CLI              | `rex`; server autostart; `rex whoami`                                |
| Paseo CLI            | `paseo`; `PASEO_HOME` (default `~/.paseo`)                           |
| Paseo agent record   | `~/.paseo/agents/<mangled-cwd>/<agent-id>.json`                      |
| pi sessions          | `~/.pi/agent/sessions/<flattened-cwd>/<timestamp>_<uuid>.jsonl`      |
| session-home         | `~/.local/state/pi/session-homes/<pid>.json`                         |
| app document         | hc `doc.get`/`doc.set` name `herdr-app`                              |
