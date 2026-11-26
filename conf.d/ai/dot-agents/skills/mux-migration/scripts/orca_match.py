#!/usr/bin/env python3
"""Match Orca pi tabs to pi session .jsonl files.

Orca exposes only agentIdentity ("pi"), not the session file. This script:
  1. uses the session-home registry when it has a record;
  2. otherwise compares the rendered Orca screen with the tail of candidate
     session files, filtered by the tab's worktree/folder.

Read-only. Use the output to choose a session file for mux_move.py.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import muxlib as m

SESSION_ROOT = Path.home() / ".pi/agent/sessions"
WINDOW = 48


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def content_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                parts.append(part.get("text") or "")
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts)
    return ""


def file_header(path: Path) -> dict:
    try:
        with path.open("rb") as handle:
            first = handle.readline(1_000_000).decode("utf-8", "replace")
        data = json.loads(first)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def file_tail_text(path: Path, read_bytes: int = 400_000) -> str:
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            handle.seek(max(0, size - read_bytes))
            data = handle.read().decode("utf-8", "replace")
    except OSError:
        return ""
    lines = data.splitlines()
    if size > read_bytes:
        lines = lines[1:]
    users, assistants = [], []
    for line in lines:
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        text = content_text(message.get("content"))
        if not text:
            continue
        if message.get("role") == "user":
            users.append(text)
        elif message.get("role") == "assistant":
            assistants.append(text)
    return normalize(" ".join(users[-4:] + assistants[-3:]))


def screen_text(handle: str) -> str:
    if not m.ORCA or not handle:
        return ""
    try:
        data = m.run_json(
            [m.ORCA, "terminal", "read", "--terminal", handle, "--screen", "--json"],
            timeout=30,
        )
        tail = ((data.get("result") or {}).get("terminal") or {}).get("tail") or []
        return "\n".join(tail)
    except Exception:
        return ""


def windows(text: str, limit: int = 100) -> list[str]:
    text = normalize(text)
    if len(text) <= WINDOW:
        return []
    step = max(1, (len(text) - WINDOW) // limit)
    out = []
    for index in range(0, len(text) - WINDOW + 1, step):
        window = text[index : index + WINDOW]
        if window.strip():
            out.append(window)
    return out


def process_start_epoch(pid: int | None) -> float | None:
    ticks = m.proc_start_ticks(pid)
    if ticks is None:
        return None
    try:
        btime = None
        for line in Path("/proc/stat").read_text().splitlines():
            if line.startswith("btime "):
                btime = int(line.split()[1])
                break
        if btime is None:
            return None
        return btime + ticks / os.sysconf("SC_CLK_TCK")
    except Exception:
        return None


def parse_timestamp(value) -> float | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(text).timestamp()
    except Exception:
        return None


def candidate_files(cwd: str | None) -> list[Path]:
    files = list(SESSION_ROOT.glob("*/*.jsonl"))
    if not cwd:
        return files
    target = str(Path(cwd))
    out = []
    for path in files:
        header = file_header(path)
        if header.get("cwd") == target:
            out.append(path)
    return out


def pi_processes_by_tab() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for pid in m.pi_pids():
        env = m.proc_env(pid)
        tab = env.get("ORCA_TAB_ID")
        if tab:
            out[tab] = {"pid": pid, "env": env, "cwd": m.proc_cwd(pid)}
    return out


def registry_by_tab() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for record in m.load_registry():
        if (record.get("home") or {}).get("kind") != "orca":
            continue
        orca = (record.get("home") or {}).get("orca") or {}
        tab = orca.get("ORCA_TAB_ID")
        if tab and m.alive((record.get("process") or {}).get("pid")):
            out[tab] = record
    return out


def tab_cwd(term: dict, worktrees: dict[str, str]) -> str | None:
    cwd = term.get("worktreePath") or ""
    if not cwd:
        cwd = worktrees.get(term.get("worktreeId") or "") or ""
    if not cwd:
        title = term.get("title") or ""
        if title.startswith("~/") or title.startswith("/"):
            cwd = os.path.expanduser(title)
    return cwd or None


def score_file(path: Path, windows_: list[str]) -> int:
    text = file_tail_text(path)
    return sum(1 for window in windows_ if window in text)


def agent_read_text(session_id: str) -> str:
    result = m.orca_agent_read(session_id, limit=20)
    entries = result.get("entries") or []
    texts = []
    for entry in entries:
        if entry.get("kind") == "message":
            texts.append(entry.get("text") or "")
    return "\n".join(texts)


def match_text(text: str, cwd: str | None, min_score: int = 8, limit: int = 3) -> dict | None:
    windows_ = windows(text)
    candidates = []
    for path in candidate_files(cwd):
        score = score_file(path, windows_)
        if score <= 0:
            continue
        header = file_header(path)
        candidates.append(
            {
                "file": str(path),
                "session_id": header.get("id") or m.session_id_from_path(str(path)),
                "score": score,
                "mtime": path.stat().st_mtime,
                "header_cwd": header.get("cwd"),
            }
        )
    candidates.sort(key=lambda item: (-item["score"], -item["mtime"]))
    best = candidates[:limit]
    if not best or best[0]["score"] < min_score:
        return None
    return {**best[0], "alternatives": best}


def native_chat_rows(args) -> list[dict]:
    rows = []
    worktrees = m.orca_worktrees()
    for chat in m.orca_agents():
        if chat.get("kind") != "chat" or chat.get("agent") != "pi":
            continue
        session_id = chat.get("orcaSessionId")
        if not session_id:
            continue
        if args.tab and args.tab not in (session_id, chat.get("paneKey")):
            continue
        worktree_id = chat.get("worktreeId") or ""
        cwd = worktree_id.split("::", 1)[1] if "::" in worktree_id else worktrees.get(worktree_id)
        text = agent_read_text(session_id)
        best = match_text(text, cwd, min_score=min(4, args.min_score), limit=args.limit)
        rows.append(
            {
                "tab": session_id,
                "handle": None,
                "kind": "chat",
                "state": chat.get("state"),
                "title": chat.get("title"),
                "pid": None,
                "cwd": cwd,
                "source": "agent-read",
                "session_file": (best or {}).get("file"),
                "session_id": (best or {}).get("session_id"),
                "score": (best or {}).get("score"),
                "alternatives": (best or {}).get("alternatives") or [],
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--tab", help="only this Orca tabId or handle")
    parser.add_argument("--min-score", type=int, default=8)
    parser.add_argument("--limit", type=int, default=3)
    args = parser.parse_args()

    if not m.ORCA:
        print("Orca CLI not found; set ORCA_CLI_COMMAND", file=sys.stderr)
        return 1

    worktrees = m.orca_worktrees()
    procs = pi_processes_by_tab()
    registry = registry_by_tab()
    rows = []
    for term in m.orca_terms():
        tab = term.get("tabId")
        handle = term.get("handle")
        if args.tab and args.tab not in (tab, handle):
            continue
        direct = procs.get(tab)
        is_pi = term.get("agentIdentity") == "pi" or bool(direct)
        if not is_pi:
            continue
        cwd = tab_cwd(term, worktrees) or (direct or {}).get("cwd")
        record = registry.get(tab)
        if record and (record.get("session") or {}).get("file"):
            row = {
                "tab": tab,
                "handle": handle,
                "title": term.get("title"),
                "pid": (record.get("process") or {}).get("pid"),
                "cwd": cwd,
                "source": "registry",
                "session_file": (record.get("session") or {}).get("file"),
                "session_id": (record.get("session") or {}).get("id"),
                "score": None,
                "alternatives": [],
            }
            rows.append(row)
            continue
        screen = screen_text(handle)
        windows_ = windows(screen)
        candidates = []
        for path in candidate_files(cwd):
            score = score_file(path, windows_)
            if score <= 0:
                continue
            header = file_header(path)
            start = process_start_epoch((direct or {}).get("pid"))
            file_time = parse_timestamp(header.get("timestamp"))
            delta = abs(file_time - start) if file_time and start else None
            candidates.append(
                {
                    "file": str(path),
                    "session_id": header.get("id") or m.session_id_from_path(str(path)),
                    "score": score,
                    "delta_seconds": round(delta, 1) if delta is not None else None,
                    "mtime": path.stat().st_mtime,
                    "header_cwd": header.get("cwd"),
                }
            )
        candidates.sort(
            key=lambda item: (
                -item["score"],
                item["delta_seconds"] if item["delta_seconds"] is not None else 10**9,
                -item["mtime"],
            )
        )
        best = candidates[: args.limit]
        rows.append(
            {
                "tab": tab,
                "handle": handle,
                "title": term.get("title"),
                "pid": (direct or {}).get("pid"),
                "cwd": cwd,
                "source": "screen",
                "session_file": best[0]["file"] if best and best[0]["score"] >= args.min_score else None,
                "session_id": best[0]["session_id"] if best and best[0]["score"] >= args.min_score else None,
                "score": best[0]["score"] if best else 0,
                "alternatives": best,
                "screen_windows": len(windows_),
            }
        )

    rows.extend(native_chat_rows(args))

    if args.json:
        print(json.dumps({"tabs": rows}, indent=2))
    else:
        for row in rows:
            print(
                f"{(row.get('tab') or '')[-8:]}  {str(row.get('pid') or '-'):>8}  "
                f"{(row.get('title') or '')[:28]:28}  {row.get('cwd') or '-'}"
            )
            print(
                f"    session: {row.get('session_id') or 'unknown'}  "
                f"source={row.get('source')} score={row.get('score')}  {row.get('session_file') or ''}"
            )
            for alt in (row.get("alternatives") or [])[1:]:
                print(
                    f"      alt {alt.get('session_id') or '?'} score={alt.get('score')} "
                    f"delta={alt.get('delta_seconds')} {alt.get('file')}"
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
