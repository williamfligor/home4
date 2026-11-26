# Migration recipes

These are the exact shapes of moves that have worked. Use the scripts for the mechanics,
but read the runtime notes for the caveats. Every recipe assumes the pi session file is
known; if it is not, stop and find it before doing anything destructive.

## Rex → hc (all open Rex pi)

This is the common "get the pi sessions out of Rex" move.

1. Inventory Rex blocks (Rex has no session file in its env; the session-home registry is
   the reliable source):

    ```sh
    python3 scripts/mux_inventory.py --runtime rex --idle
    ```

    Unknown `FILE` means the registry has no record. Find the file before moving that block
    (`/where` inside pi if the session-home extension is loaded, a manual look at the pi
    title/session, or start a fresh session). Do not move a guessed file.

2. Dry-run:

    ```sh
    python3 scripts/mux_move.py --from rex --to hc --all
    ```

    Skip the current session (`*`). Resolve `DUP` before applying.

3. Apply. The mover stops each Rex block and starts the hc terminal with
   `pi --session <file>`. If you are doing it manually:

    ```sh
    rex block close -s <rex-session> <rex-block>
    hc run --bg --keep --no-parent --name <project>-<shortid> \
      --cwd <cwd> --label from=rex --label sync.pi=<file> --json \
      -- pi --session <file>
    ```

    hc `--name` must be `[a-z0-9-_]{1,32}`. `--json` comes before `--`.
    Verify with `hc get <addr> --json` (foreground pi) and `hc ls --json`.

4. If the user is looking at herdr-app, place the hc terminals:

    ```sh
    python3 scripts/hc_place.py
    python3 scripts/hc_place.py --apply
    ```

    This reuses one space per folder. If the app already has a mise folder with "unrelated"
    tabs, merge the second `mise` space instead of creating another; `hc_place.py` does it.

5. Rex cleanup: closing the last block leaves an empty session. Close empty sessions only
   after verification:

    ```sh
    rex session kill <empty-session-label>
    ```

    Keep Rex shell windows that the user wants; this recipe moves pi sessions, not shells.

## hc → Rex

1. Inventory hc with the labels:

    ```sh
    python3 scripts/mux_inventory.py --runtime hc --idle
    ```

    For each terminal the session file can come from:
    - `hc get <addr> --json` → `labels.sync.pi`;
    - `labels.wake` → JSON with `session_file`/`session_id` (prefer this when the pi was
      resumed or forked; it is newer than `sync.pi`);
    - `foreground.argv` → after `--session`;
    - otherwise the terminal has a shell running pi with no session path; do not guess.

2. Dry-run `mux_move.py --from hc --to rex --all`, then apply. It creates one Rex session
   per project folder and one window per pi. Manual shape:

    ```sh
    hc kill t4j --json
    rex new mise -c /home/will/.config/mise --window 'mise · t4b' --interactive --json \
      -- pi --session /path/session.jsonl
    ```

    Later windows in the same project:

    ```sh
    rex window new -s mise 'mise · t4d' -c /home/will/.config/mise --interactive --json \
      -- pi --session /path/other.jsonl
    ```

3. Verify with `rex block call -s mise -b <block> process` (`argv0: pi`) and
   `rex capture -s mise -b <block> --trim` (prompt). Run `rex skill setup` for Pi once.

4. hc terminals can be removed after the pi is gone (`hc kill` already ends it). Finished
   terminals are hidden from `hc ls`; `hc ls --all` shows them, and `hc rm` removes them.

## Orca → Rex or hc

Orca is the hard source because it does not expose the `.jsonl`.

1. Try the registry first:

    ```sh
    python3 scripts/mux_inventory.py --runtime orca --idle
    ```

2. If `FILE` is unknown, use the matcher:

    ```sh
    python3 scripts/orca_match.py
    ```

    It reads each Orca pi tab's rendered screen, filters session files by the tab's worktree,
    ranks 48-character screen windows against the last user/assistant messages, and uses the
    process start/file timestamp to break ties. Orca `terminal.title` is the running
    program's title, never use it as an identity.

3. Dry-run the move with the chosen file:

    ```sh
    python3 scripts/mux_move.py --from orca --to rex --session <session-id-or-file>
    ```

    The current Orca tab is marked `*`; skip it. Orca handles are runtime-scoped: if Orca
    restarted, re-list and use the current handle; `tabId` is durable.

4. Apply. The mover closes the Orca tab (`terminal close --terminal <handle> --tab`) before
   starting the destination. Manual destination commands are in `runtimes.md`.

5. Orca destination: `terminal create --worktree path:<cwd>` only works for known
   worktrees. A folder workspace's `worktreePath` can be empty; resolve `worktreeId` through
   `orca worktree ps`. `--add-repo` is an explicit, visible sidebar change.

## herdr → hc or Rex

1. Snapshot herdr:

    ```sh
    herdr api snapshot | jq '.result.snapshot.panes[] | {pane_id,agent,agent_status,agent_session,cwd}'
    ```

    `agent_session.value` is the exact session file for a pi pane.

2. Wait for `agent_status: idle`. Close the owner pane:

    ```sh
    herdr pane close w42:p1
    ```

    A pane running `hc attach <addr>` is a viewer; closing it only detaches. Do not close
    the viewer when you mean to stop the hc owner, and do not close the owner when you only
    mean to hide it.

3. Start hc/Rex with the file. If the pane's process is gone, the `.jsonl` is still the
   state. `herdr tab create` does not return a pane id; snapshot before/after.

4. To put a destination hc terminal back in herdr, create a herdr tab/pane and run
   `hc attach <addr>` there (`ctrl+\` detaches). herdr cannot be the owner of a session that
   hc owns; it can only view it.

## All open pi sessions → one destination

1. Inventory all runtimes; group by `session_id`/`session_file`, not title.
2. Exclude the current session. Exclude sessions with no known file until you find it.
3. Resolve duplicate owners first: stop both, then start one destination. If you start
   before stopping, you have two writers and a corrupt conversation.
4. Use `mux_move.py --from any --to <dest> --all` for a plan; apply one session at a time
   when the user wants to watch. The mover stops all owners of a session before starting.
5. Choose the destination layout deliberately:
    - hc: one terminal per pi; names `[a-z0-9-_]`; labels `sync.pi` and `sync.title`;
      place in herdr-app. `sync.title` keeps the original tab name for the app and the
      return move; do not replace it with the sanitized hc name.
    - Rex: one session per project, one window per pi; `REX_SESSION`/`REX_BLOCK`.
    - Orca: one tab per pi; known worktree; no session path afterwards. A structured Chat
      UI tab is `orca-chat`: move it out with `--allow-native-chat`; the runtime
      `agentSession.close` RPC retires the tab. If that RPC is unavailable, close the
      remaining tab in Orca. Migrating to Orca uses a terminal, not native chat, until Orca
      exposes `agent launch --surface chat --resume-from` and chat close.
    - herdr: one pane per pi; `agent_session` is the proof.
6. Clean up old owners and empty containers after verification.

## Orca native chat

A structured Orca chat is not a terminal. Its `orca-chat` owner has an Orca session ID,
not a terminal handle.

1. `mux_inventory.py` lists it as `orca-chat`; the current chat is marked `*` and must
   stay. The inventory resolves the `.jsonl` from the pi parent's `--session`, or by
   matching `orca agent read` text against session files.
2. Move it out with:

    ```sh
    mux_move.py --from orca --to hc --session <orca-session-id> \
      --allow-native-chat --apply
    ```

    This stops the RPC pi, starts the destination with the same `.jsonl`, and closes the
    Orca chat tab through the app's `agentSession.close` runtime RPC. The CLI still lacks
    `chat close` (PR #39918), so if that RPC is unavailable the tab is left open and must be
    closed in the UI.

3. Moving back to Orca uses `--to orca` (terminal) or `--to orca --orca-native-chat`
   (Chat UI). The native-chat path calls `agentSession.create` with `resumeFrom`; if a
   dormant chat still owns the conversation, Orca returns `conversationHeldElsewhere` and
   the mover calls `agentSession.reveal` for that chat instead of creating a second one.
   This mirrors the desktop `/resume` command. Pi native-chat `forkFrom` is refused
   (`structured_agent_session_unsupported`), so fork is not an alternative.

## Paseo

Paseo agents are workspace sessions, not terminals. Import is the destination; archive is
the source stop.

1. Inventory:

    ```sh
    python3 scripts/mux_inventory.py
    ```

    Paseo rows use home `paseo`; the session file comes from
    `~/.paseo/agents/*/*.json` → `persistence.nativeHandle`.

2. Move into Paseo:

    ```sh
    python3 scripts/mux_move.py --from hc --to paseo --session <id> --apply
    ```

    This runs `paseo import <pi-session-id> --provider pi --cwd <cwd>`. Import creates an
    idle agent; it does not start pi until a message is sent.

3. Move out of Paseo:

    ```sh
    python3 scripts/mux_move.py --from paseo --to hc --session <id> --apply
    ```

    The source stop runs `paseo stop <agent-id>` then
    `paseo archive <agent-id> --force`, and verifies the pi pid is gone. An idle Paseo
    agent still has a process, so stop alone is not enough.

4. If the user wants the archived Paseo record gone, use `paseo delete <agent-id>`.

## Shells

Shells have no conversation state and no session file. Do not use the pi mover for them.

1. Create the destination shell first (so a failure does not lose the old one):
    - hc: `hc run --bg --keep --no-parent --name <name> --cwd <cwd>` (no program).
    - Rex: `rex new <project> -c <cwd> --window <label>` or `rex window new`.
    - Orca: `orca terminal create --worktree path:<cwd> --title <title>`.
    - herdr: `herdr tab create --workspace <id> --label <label> --cwd <cwd>`.
2. If the old shell runs a server or a long command, read its screen/foreground first;
   restart that program rather than assuming the shell was idle.
3. Close the old shell (`hc kill`, `orca terminal close --tab`, `herdr pane close`, or
   `rex block close`). Scrollback is not preserved; say so.

## hc → herdr-app placement (the "nothing in hc" failure)

Symptoms: `hc ls` shows the terminals, but the app shows only a couple of tabs or nothing.
The app document does not know them.

1. Check labels:

    ```sh
    hc get t4j --json | jq '.labels'
    ```

    A placed terminal has `herdr.space`, `herdr.tab`, and usually `where`.

2. Run the placement helper dry:

    ```sh
    python3 scripts/hc_place.py
    ```

    It finds live hc terminals whose `herdr.space`/`herdr.tab` is not in the doc, groups them
    by cwd folder, reuses one space per folder, merges duplicate spaces for a folder, creates
    one tab per terminal, and updates labels/`where`.

3. Apply, then refresh the app:

    ```sh
    python3 scripts/hc_place.py --apply
    ```

4. If the app still shows nothing:
    - `hc ls` may be talking to a different core than the app: compare `HC_SESSION` /
      `HC_SOCKET` and use `hc ls` against that socket.
    - Check that the doc's space name/folder is what the app groups by; a second space with
      the same folder is the classic "only two unrelated tabs" bug. Merge, do not create.
    - The app may cache; reopen/reload the client.

## Verification and cleanup

- Old pid is gone; new destination foreground is pi. For hc:
  `hc get <addr> --json` → `foreground.argv[0] == "pi"` and `labels.sync.pi` matches.
- For Rex: `rex block call -s <session> -b <block> process` → `foreground.argv0 == "pi"`;
  `rex capture` shows the prompt.
- For herdr: snapshot pane `agent == "pi"` and `agent_session.value` matches the file.
- For Orca: the new tab has `agentIdentity == "pi"`; there is no file proof.
- The session file exists; if it is pending, note that pi creates it on the first turn.
- No second owner: `mux_inventory.py` should not show `DUP` for that session.
- hc finished terminals: `hc ls --all`; remove with `hc rm` if desired.
- Empty Rex sessions: `rex ls`; remove with `rex session kill` after the user agrees.
- Orca tabs: only the intended `mise · 2`/current tab should remain; close old tabs before
  they are mistaken for owners.

## Troubleshooting quick answers

- **`hc` name rejected:** `--name` is lowercase `a-z0-9-_`, length 1–32; no dots, spaces,
  `·`, or Unicode. The script's `safe_name`/`unique_hc_name` does this.
- **Rex `unknown shorthand flag: 'b'`:** `block rename` and `block close` take the block
  positionally after `-s`; only `block call` accepts `-b`.
- **Orca close says `ptyKilled: false`:** verify the pid/tab; the tab may still be gone.
- **The session file is older than the process:** a resume/fork is normal; use the wake
  label, not a guessed filename. The file header's id/cwd is the session identity.
- **The current session appears:** you are about to kill yourself. Pick another agent or
  leave it; `mux_inventory.py` marks it `*`.
- **Two owners of one file:** stop both before starting the destination; never "let the
  newest one win".
- **The app shows a folder with unrelated tabs:** merge the duplicate space for that
  folder; the second space is hidden or skipped by the app.
