#!/usr/bin/env python3
"""Inventory live pi sessions and the terminal that currently owns each one.

Read-only. It combines the optional session-home registry with direct process
inspection and each runtime's CLI, so it still works when the registry is
missing or stale.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import muxlib as m
import orca_match as matcher

HOME_ORDER = {"orca": 0, "paseo": 1, "hc": 2, "herdr": 3, "rex": 4, "plain": 5}


def registry_owner(record: dict) -> dict:
    home = record.get("home") or {}
    kind = home.get("kind") or "plain"
    owner: dict = {"kind": kind}
    if kind == "orca":
        data = home.get("orca") or {}
        owner.update(
            handle=data.get("ORCA_TERMINAL_HANDLE"),
            tab=data.get("ORCA_TAB_ID"),
            pane=data.get("ORCA_PANE_KEY"),
            worktree=data.get("ORCA_WORKTREE_ID"),
        )
    elif kind == "hc":
        data = home.get("hc") or {}
        owner.update(terminal=data.get("HC_TERMINAL_ID"), socket=data.get("HC_TERMINAL_SOCKET"))
    elif kind == "herdr":
        data = home.get("herdr") or {}
        owner.update(
            pane=data.get("HERDR_PANE_ID"),
            tab=data.get("HERDR_TAB_ID"),
            workspace=data.get("HERDR_WORKSPACE_ID"),
            socket=data.get("HERDR_SOCKET_PATH"),
        )
    elif kind == "rex":
        data = home.get("rex") or {}
        owner.update(block=data.get("REX_BLOCK"), session=data.get("REX_SESSION"))
    return owner


def find_record(records: list[dict], *, pid=None, session_file=None, owner=None) -> dict | None:
    for record in records:
        if pid and record.get("pid") == pid:
            return record
        if (
            session_file
            and record.get("session_file") == session_file
            and record.get("owner", {}).get("kind") == (owner or {}).get("kind")
        ):
            return record
        if owner:
            current = record.get("owner") or {}
            if current.get("kind") != owner.get("kind"):
                continue
            keys = {
                "orca": ("handle", "tab"),
                "orca-chat": ("session",),
                "hc": ("terminal",),
                "herdr": ("pane",),
                "rex": ("block",),
                "paseo": ("agent",),
            }.get(owner.get("kind"), ())
            if any(owner.get(key) and owner.get(key) == current.get(key) for key in keys):
                return record
    return None


def worktree_path(worktree_id: str | None, worktrees: dict[str, str]) -> str | None:
    if not worktree_id:
        return None
    if "::" in worktree_id:
        return worktree_id.split("::", 1)[1]
    return worktrees.get(worktree_id)


def native_chat_file(chat: dict, pid: int | None, cwd: str | None) -> str | None:
    if pid:
        file = m.pi_session_file_from_proc(pid)
        if file:
            return file
    session_id = chat.get("orcaSessionId")
    if not session_id:
        return None
    text = matcher.agent_read_text(session_id)
    best = matcher.match_text(text, cwd, min_score=4)
    return (best or {}).get("file")


def add_native_chats(records: list[dict], worktrees: dict[str, str]) -> None:
    native_pids: dict[str, int] = {}
    for pid in m.pi_pids():
        env = m.proc_env(pid)
        session_id = env.get("ORCA_AGENT_SESSION_ID")
        if session_id and not (env.get("ORCA_TAB_ID") or env.get("ORCA_TERMINAL_HANDLE")):
            native_pids[session_id] = pid

    for chat in m.orca_agents():
        if chat.get("kind") != "chat" or chat.get("agent") != "pi":
            continue
        session_id = chat.get("orcaSessionId")
        if not session_id:
            continue
        cwd = chat.get("worktreePath") or worktree_path(chat.get("worktreeId"), worktrees)
        pid = native_pids.get(session_id)
        file = native_chat_file(chat, pid, cwd)
        record = find_record(records, pid=pid) or find_record(
            records, owner={"kind": "orca-chat", "session": session_id}
        )
        owner = {
            "kind": "orca-chat",
            "session": session_id,
            "pane": chat.get("paneKey"),
            "state": chat.get("state"),
        }
        if record is None:
            record = {
                "pid": pid,
                "home": "orca",
                "owner": owner,
                "cwd": cwd,
                "session_id": m.session_id_from_path(file),
                "session_file": file,
                "title": chat.get("title"),
                "source": "orca-chat",
                "alive": bool(pid),
                "native_chat": True,
                "native_chat_state": chat.get("state"),
            }
            records.append(record)
        else:
            record.update(
                home="orca",
                owner={**record.get("owner", {}), **owner},
                cwd=record.get("cwd") or cwd,
                session_id=record.get("session_id") or m.session_id_from_path(file),
                session_file=record.get("session_file") or file,
                title=record.get("title") or chat.get("title"),
                alive=bool(pid),
                native_chat=True,
                native_chat_state=chat.get("state"),
            )


def build(include_dead: bool = False) -> list[dict]:
    records: list[dict] = []
    registry = m.load_registry()
    registry_by_pid = {}
    for entry in registry:
        pid = (entry.get("process") or {}).get("pid")
        if pid:
            registry_by_pid[pid] = entry
        session = entry.get("session") or {}
        if not m.alive(pid) and not include_dead:
            continue
        records.append(
            {
                "pid": pid,
                "home": (entry.get("home") or {}).get("kind") or "plain",
                "owner": registry_owner(entry),
                "cwd": session.get("cwd"),
                "session_id": session.get("id"),
                "session_file": session.get("file"),
                "title": session.get("name"),
                "source": "registry",
                "alive": m.alive(pid),
                "_registry": entry,
            }
        )

    # Direct pi processes: catches hc/Rex/Orca terminals the registry has not seen.
    for pid in m.pi_pids():
        existing = find_record(records, pid=pid)
        env = m.proc_env(pid)
        home = m.home_from_env(env)
        owner = m.owner_from_env(env)
        if existing:
            existing.update(home=home, owner=owner, alive=True)
            if not existing.get("cwd"):
                existing["cwd"] = m.proc_cwd(pid)
            continue
        session = (registry_by_pid.get(pid) or {}).get("session") or {}
        records.append(
            {
                "pid": pid,
                "home": home,
                "owner": owner,
                "cwd": session.get("cwd") or m.proc_cwd(pid),
                "session_id": session.get("id"),
                "session_file": session.get("file"),
                "title": session.get("name"),
                "source": "process",
                "alive": True,
            }
        )

    # Paseo agents: its agent JSON is authoritative for cwd and the pi session file.
    paseo_pids = m.paseo_agent_pids()
    for agent in m.paseo_agents():
        agent_id = agent.get("id")
        pid = paseo_pids.get(agent_id)
        record = (
            (find_record(records, pid=pid) if pid else None)
            or find_record(records, owner={"kind": "paseo", "agent": agent_id})
            or find_record(records, session_file=agent.get("file"))
        )
        if record is None:
            if not pid:
                continue
            record = {
                "pid": pid,
                "home": "paseo",
                "owner": {"kind": "paseo", "agent": agent_id, "workspace": agent.get("workspace")},
                "cwd": agent.get("cwd"),
                "session_id": agent.get("session_id"),
                "session_file": agent.get("file"),
                "title": agent.get("title"),
                "source": "paseo",
                "alive": True,
            }
            records.append(record)
        else:
            record.update(
                home="paseo",
                owner={
                    **record.get("owner", {}),
                    "kind": "paseo",
                    "agent": agent_id,
                    "workspace": agent.get("workspace"),
                },
                cwd=record.get("cwd") or agent.get("cwd"),
                session_id=record.get("session_id") or agent.get("session_id"),
                session_file=record.get("session_file") or agent.get("file"),
                title=record.get("title") or agent.get("title"),
                alive=bool(pid),
            )

    # herdr-core terminals, including its wake labels and sync.pi labels.
    for term in m.hc_terms():
        if term.get("state") != "live":
            continue
        address = term.get("address")
        info = m.hc_session(address)
        try:
            full = m.hc_get(address)
        except Exception:
            continue
        labels = full.get("labels") or {}
        sync_title = (labels.get("sync.title") or "").strip()
        foreground = full.get("foreground") or {}
        pid = foreground.get("pid")
        argv = foreground.get("argv") or []
        is_pi = (
            term.get("agent") == "pi"
            or foreground.get("name") in ("pi", "node")
            or (argv and argv[0] == "pi")
        )
        if not is_pi or not pid:
            continue
        record = find_record(records, pid=pid) or find_record(
            records, owner={"kind": "hc", "terminal": address}
        )
        if record is None:
            record = {
                "pid": pid,
                "home": "hc",
                "owner": {"kind": "hc", "terminal": address},
                "cwd": info.get("cwd") or term.get("cwd"),
                "session_id": info.get("session_id"),
                "session_file": info.get("file"),
                "title": sync_title or info.get("name") or info.get("title"),
                "source": "hc",
                "alive": True,
            }
            records.append(record)
        else:
            record.update(
                home="hc",
                owner={"kind": "hc", "terminal": address},
                cwd=record.get("cwd") or info.get("cwd") or term.get("cwd"),
                session_id=record.get("session_id") or info.get("session_id"),
                session_file=record.get("session_file") or info.get("file"),
                title=sync_title or record.get("title") or info.get("name") or info.get("title"),
                alive=True,
            )

    # herdr panes: the snapshot is authoritative for agent_session.
    snapshot = m.herdr_snapshot()
    for pane in snapshot.get("panes") or []:
        session = pane.get("agent_session") or {}
        if pane.get("agent") != "pi" and session.get("agent") != "pi":
            continue
        file = session.get("value") if session.get("kind") == "path" else None
        record = (
            find_record(
                records,
                session_file=file,
                owner={"kind": "herdr", "pane": pane.get("pane_id")},
            )
            or find_record(records, owner={"kind": "herdr", "pane": pane.get("pane_id")})
            or find_record(records, session_file=file)
        )
        if record is None:
            record = {
                "pid": None,
                "home": "herdr",
                "owner": {"kind": "herdr", "pane": pane.get("pane_id")},
                "cwd": pane.get("cwd"),
                "session_id": m.session_id_from_path(file),
                "session_file": file,
                "title": pane.get("terminal_title"),
                "source": "herdr",
                "alive": True,
            }
            records.append(record)
        else:
            record.update(
                home="herdr",
                owner={"kind": "herdr", "pane": pane.get("pane_id")},
                cwd=record.get("cwd") or pane.get("cwd"),
                session_id=record.get("session_id") or m.session_id_from_path(file),
                session_file=record.get("session_file") or file,
                title=record.get("title") or pane.get("terminal_title"),
            )

    # Orca terminals. The pi hook's status DB is authoritative when the pi argv is bare.
    worktrees = m.orca_worktrees()
    orca_status = m.orca_agent_status_sessions()
    for term in m.orca_terms():
        handle = term.get("handle")
        tab = term.get("tabId")
        if term.get("agentIdentity") != "pi":
            # A pi can run inside a shell tab; direct process records still own it.
            if not find_record(records, owner={"kind": "orca", "handle": handle}):
                continue
        status = orca_status.get(tab) or {}
        record = find_record(records, owner={"kind": "orca", "handle": handle}) or find_record(
            records, owner={"kind": "orca", "tab": tab}
        )
        if record is None:
            record = {
                "pid": None,
                "home": "orca",
                "owner": {"kind": "orca", "handle": handle, "tab": tab},
                "cwd": term.get("worktreePath") or worktrees.get(term.get("worktreeId") or ""),
                "session_id": status.get("session_id"),
                "session_file": status.get("file"),
                "title": term.get("title"),
                "source": "orca-status" if status else "orca",
                "alive": True,
            }
            records.append(record)
        else:
            record.update(
                home="orca",
                session_id=record.get("session_id") or status.get("session_id"),
                session_file=record.get("session_file") or status.get("file"),
                source=record.get("source") if record.get("session_file") else "orca-status",
                owner={
                    **record.get("owner", {}),
                    "kind": "orca",
                    "handle": handle,
                    "tab": tab,
                },
                cwd=record.get("cwd")
                or term.get("worktreePath")
                or worktrees.get(term.get("worktreeId") or ""),
                title=record.get("title") or term.get("title"),
            )

    add_native_chats(records, worktrees)

    # Rex blocks.
    for session in m.rex_sessions():
        sid = session.get("session_id")
        label = session.get("label")
        for block in m.rex_blocks(sid):
            process = m.rex_process(sid, block.get("block_id"))
            foreground = process.get("foreground") or {}
            pid = foreground.get("pid")
            if foreground.get("name") not in ("pi", "node") and (foreground.get("argv") or [None])[0] != "pi":
                continue
            record = (
                find_record(records, pid=pid)
                or find_record(records, owner={"kind": "rex", "block": block.get("block_id")})
                or find_record(
                    records,
                    owner={
                        "kind": "rex",
                        "session": sid,
                        "block": block.get("block_id"),
                    },
                )
            )
            resumed = m.rex_agent_resume_record(block.get("block_id"), pid)
            if record is None:
                record = {
                    "pid": pid,
                    "home": "rex",
                    "owner": {
                        "kind": "rex",
                        "session": sid,
                        "block": block.get("block_id"),
                    },
                    "cwd": (resumed or {}).get("cwd") or foreground.get("cwd"),
                    "session_id": None,
                    "session_file": (resumed or {}).get("id"),
                    "title": block.get("label") or label,
                    "source": "rex" + (" + rex-agent-resume" if resumed else ""),
                    "alive": True,
                }
                records.append(record)
            else:
                record.update(
                    home="rex",
                    owner={
                        "kind": "rex",
                        "session": sid,
                        "block": block.get("block_id"),
                    },
                    cwd=record.get("cwd") or foreground.get("cwd"),
                    title=record.get("title") or block.get("label") or label,
                )
                # A /proc-only record has no session; the agent's own report does.
                if resumed and not record.get("session_file"):
                    record.update(
                        session_file=resumed.get("id"),
                        source=f"{record.get('source')} + rex-agent-resume",
                    )

    # Fill state and mark the current process.
    ancestor = m.current_pids()
    markers = m.current_owners()
    for record in records:
        # Runtime-only entries (Orca within a shell tab, herdr pane without a
        # registry pid) have no pid but are still live owners.
        if record.get("pid"):
            record["alive"] = m.alive(record.get("pid"))
        file = record.get("session_file")
        record["file"] = "ok" if file and Path(file).exists() else ("pending" if file else "unknown")
        record["pending"] = bool(record["alive"] and file and not Path(file).exists())
        record["current"] = m.record_is_current(record, ancestor, markers)
        if not record.get("session_id"):
            record["session_id"] = m.session_id_from_path(file)

    # Duplicate live owners of one session.
    groups: dict[str, list[dict]] = {}
    for record in records:
        if not record["alive"]:
            continue
        key = record.get("session_id") or record.get("session_file")
        if key:
            groups.setdefault(key, []).append(record)
    for key, group in groups.items():
        for record in group:
            record["owners"] = len(group)

    records.sort(
        key=lambda r: (
            HOME_ORDER.get(r.get("home"), 9),
            str(r.get("cwd")),
            str(r.get("session_id") or ""),
            str(r.get("pid") or 0),
        )
    )
    return records


def table(records: list[dict]) -> str:
    lines = []
    header = f"{'':2} {'PID':>8}  {'HOME':6} {'OWNER':22} {'SESSION':10} {'FILE':7} {'CWD'}"
    lines.append(header)
    lines.append("-" * len(header))
    for record in records:
        owner = record.get("owner") or {}
        if owner.get("kind") == "orca-chat":
            owner_text = f"orca-chat:{(owner.get('session') or '?')[-8:]}"
        elif owner.get("kind") == "orca":
            owner_text = f"orca {owner.get('tab') or owner.get('handle') or '?'}"
        elif owner.get("kind") == "hc":
            owner_text = f"hc:{owner.get('terminal')}"
        elif owner.get("kind") == "herdr":
            owner_text = f"herdr:{owner.get('pane')}"
        elif owner.get("kind") == "rex":
            owner_text = f"rex:{(owner.get('session') or '')[-8:]}:{(owner.get('block') or '')[-8:]}"
        else:
            owner_text = owner.get("kind") or "?"
        flag = "*" if record.get("current") else " "
        dup = " DUP" if (record.get("owners") or 0) > 1 else ""
        session = (record.get("session_id") or "-")[-8:]
        lines.append(
            f"{flag:2} {str(record.get('pid') or '-'):>8}  {record.get('home') or '?':6} "
            f"{owner_text[:22]:22} {session:10} {record.get('file') or '?':7} "
            f"{record.get('cwd') or '?'}{dup}"
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument("--all", action="store_true", help="include dead registry records")
    parser.add_argument("--runtime", choices=["orca", "hc", "herdr", "rex", "plain"])
    parser.add_argument("--idle", action="store_true", help="probe each live session's prompt (slower)")
    args = parser.parse_args()
    records = build(include_dead=args.all)
    if args.runtime:
        records = [record for record in records if record.get("home") == args.runtime]
    if args.idle:
        for record in records:
            if record.get("alive"):
                ok, detail = m.idle(record)
                record["idle"] = ok
                record["idle_detail"] = detail
    if args.json:
        print(json.dumps({"sessions": records}, indent=2))
    else:
        print(table(records))
        live = [record for record in records if record.get("alive")]
        dup = [record for record in live if (record.get("owners") or 0) > 1]
        print(f"\n{len(live)} live pi session(s); {len(dup)} with duplicate owners.")
        current = [record for record in live if record.get("current")]
        if current:
            print("current/in-use: " + ", ".join(str(record.get("pid")) for record in current))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
