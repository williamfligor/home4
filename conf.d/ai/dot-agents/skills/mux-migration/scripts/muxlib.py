#!/usr/bin/env python3
"""Shared helpers for one-shot pi session migrations between agent runtimes.

The runtime adapters are intentionally small and use each runtime's public CLI.
Nothing here is a daemon and nothing runs on a timer: every function is called
by a migration command that the user asked for.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path

HOME = Path.home()
STATE_DIR = Path(os.environ.get("PI_SESSION_HOMES_DIR") or HOME / ".local/state/pi/session-homes")
DOC_NAME = "herdr-app"


def _find_cli(*names: str, paths: tuple[str, ...] = ()) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    for raw in paths:
        path = Path(os.path.expanduser(raw))
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return None


# Orca's Linux CLI can collide with the GNOME screen reader, /usr/bin/orca.
# Never fall back to a bare `orca` on Linux. ORCA_CLI_COMMAND wins everywhere.
ORCA = os.environ.get("ORCA_CLI_COMMAND") or _find_cli(
    "orca-ide",
    paths=("~/.config/orca/cli/bin/orca",),
)
HC = _find_cli("hc")
HERDR = _find_cli("herdr")
REX = _find_cli("rex")
PASEO = os.environ.get("PASEO_CLI_COMMAND") or _find_cli("paseo")
PI = _find_cli("pi")


def run(
    cmd: list[str],
    timeout: int = 60,
    env: dict | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        input=input_text,
        text=True,
        errors="replace",
        capture_output=True,
        timeout=timeout,
        env={**os.environ, **(env or {})},
    )


def json_from_text(text: str):
    """Parse the first JSON object or array in text, skipping CLI chatter."""
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise ValueError(f"no JSON in output: {text[:300]!r}")
    return json.loads(text[min(starts) :])


def run_json(cmd: list[str], timeout: int = 60) -> dict:
    proc = run(cmd, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({proc.returncode}): {proc.stderr.strip()[:300]}")
    return json_from_text(proc.stdout)


def hc_call(method: str, params: dict | None = None, timeout: int = 60) -> dict:
    if not HC:
        raise RuntimeError("hc is not on PATH")
    message = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
    proc = run([HC, "connect"], input_text=message + "\n", timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"hc connect failed: {proc.stderr.strip()[:300]}")
    for line in proc.stdout.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if payload.get("id") != 1:
            continue
        if "error" in payload:
            raise RuntimeError(f"{method}: {payload['error']}")
        return payload.get("result") or {}
    raise RuntimeError(f"{method}: no JSON-RPC response")


def hc_terms() -> list[dict]:
    try:
        return hc_call("terminal.list").get("terminals") or []
    except Exception:
        return []


def hc_get(terminal: str) -> dict:
    if not HC:
        raise RuntimeError("hc is not on PATH")
    return run_json([HC, "get", terminal, "--json"])


def hc_session(terminal: str) -> dict:
    """Read the pi session path/session id out of an hc terminal's labels/argv."""
    try:
        record = hc_get(terminal)
    except Exception:
        return {}
    labels = record.get("labels") or {}
    result: dict = {
        "terminal": terminal,
        "name": record.get("name"),
        "title": record.get("title"),
        "cwd": record.get("cwd"),
        "state": record.get("state"),
        "labels": labels,
    }
    wake = labels.get("wake")
    wake_data = {}
    if wake:
        try:
            wake_data = json.loads(wake)
        except Exception:
            wake_data = {}
    # herdr-wake rewrites this label when the pi process resumes/forking, so it
    # is more current than a sync.pi label written when the terminal was made.
    file = wake_data.get("session_file") or labels.get("sync.pi")
    if wake_data.get("session_id"):
        result["session_id"] = wake_data["session_id"]
    if wake_data.get("cwd"):
        result["cwd"] = wake_data["cwd"]
    foreground = record.get("foreground") or {}
    argv = foreground.get("argv") or []
    if "--session" in argv:
        index = argv.index("--session")
        if index + 1 < len(argv):
            file = file or argv[index + 1]
    result["file"] = file
    if file and not result.get("session_id"):
        result["session_id"] = session_id_from_path(file)
    return result


def orca_terms() -> list[dict]:
    if not ORCA:
        return []
    try:
        data = run_json([ORCA, "terminal", "list", "--include-visual-layouts", "--json"])
    except Exception:
        return []
    return ((data.get("result") or {}).get("terminals")) or []


def orca_agents() -> list[dict]:
    """Native chats, terminal agents, and the Orca session IDs they report."""
    if not ORCA:
        return []
    try:
        data = run_json([ORCA, "agent", "list", "--json"], timeout=60)
    except Exception:
        return []
    return ((data.get("result") or {}).get("agents")) or []


def orca_agent_status_sessions() -> dict[str, dict]:
    """Read the Orca agent-status DB's provider transcript per tab.

    Terminal-launched pi often has a bare `pi` argv, so the process cannot
    reveal its `--session` path.  Orca's pi hook records the transcript path
    here; it is the same value Chat UI uses for resume.
    """
    roots = []
    for key in ("ORCA_USER_DATA_PATH", "ORCA_USER_DATA"):
        value = os.environ.get(key)
        if value:
            roots.append(Path(value).expanduser())
    roots.append(HOME / ".config/orca")
    path = next(
        (
            root / "agent-hooks/last-status.db"
            for root in roots
            if (root / "agent-hooks/last-status.db").is_file()
        ),
        None,
    )
    if not path:
        return {}
    out: dict[str, dict] = {}
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        for _key, _seq, value in con.execute("select key, seq, value from rows where key like 'entry%'"):
            try:
                data = json.loads(value)
            except (TypeError, ValueError):
                continue
            provider = data.get("providerSession") or {}
            file = provider.get("transcriptPath")
            tab = data.get("tabId")
            if not tab or not file:
                continue
            out[tab] = {
                "file": file,
                "session_id": provider.get("id") or session_id_from_path(file),
                "pane": data.get("paneKey"),
                "agent": (data.get("agentPresence") or {}).get("agent"),
                "received_at": data.get("receivedAt"),
            }
    except sqlite3.Error:
        return {}
    finally:
        try:
            con.close()
        except Exception:
            pass
    return out


def orca_agent_read(session_id: str, limit: int = 20) -> dict:
    """Read a native chat's transcript without starting or stopping it."""
    if not ORCA or not session_id:
        return {}
    try:
        data = run_json(
            [
                ORCA,
                "agent",
                "read",
                session_id,
                "--limit",
                str(limit),
                "--json",
            ],
            timeout=30,
        )
    except Exception:
        return {}
    return data.get("result") or data


def orca_worktrees() -> dict[str, str]:
    if not ORCA:
        return {}
    try:
        data = run_json([ORCA, "worktree", "ps", "--json"])
    except Exception:
        return {}
    out: dict[str, str] = {}
    for worktree in ((data.get("result") or {}).get("worktrees")) or []:
        worktree_id = worktree.get("worktreeId")
        path = worktree.get("path")
        if worktree_id and path:
            out[worktree_id] = path
    return out


def paseo_home() -> Path:
    return Path(os.environ.get("PASEO_HOME") or HOME / ".paseo").expanduser()


def paseo_agents() -> list[dict]:
    """Read Paseo's per-agent records, including the provider session file."""
    root = paseo_home() / "agents"
    if not root.is_dir():
        return []
    out: list[dict] = []
    for path in sorted(root.glob("*/*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if data.get("provider") != "pi":
            continue
        persistence = data.get("persistence") or {}
        runtime = data.get("runtimeInfo") or {}
        file = persistence.get("nativeHandle")
        if not file:
            continue
        out.append(
            {
                "id": data.get("id"),
                "session_id": persistence.get("sessionId")
                or runtime.get("sessionId")
                or session_id_from_path(file),
                "file": file,
                "cwd": data.get("cwd"),
                "workspace": data.get("workspaceId"),
                "title": data.get("title"),
                "labels": data.get("labels") or {},
                "status": data.get("lastStatus"),
                "archived": data.get("archived")
                or data.get("archivedAt")
                or data.get("lastStatus") == "archived",
            }
        )
    return out


def paseo_agent_pids() -> dict[str, int]:
    """Map Paseo agent IDs to the pi processes the daemon is running."""
    out: dict[str, int] = {}
    for pid in pi_pids():
        agent_id = proc_env(pid).get("PASEO_AGENT_ID")
        if agent_id:
            out[agent_id] = pid
    return out


def herdr_snapshot() -> dict:
    if not HERDR:
        return {}
    try:
        data = run_json([HERDR, "api", "snapshot"])
    except Exception:
        return {}
    return ((data.get("result") or {}).get("snapshot")) or {}


def rex_sessions() -> list[dict]:
    if not REX:
        return []
    try:
        data = run_json([REX, "ls", "--json"])
    except Exception:
        return []
    return data.get("sessions") or []


def rex_blocks(session: str) -> list[dict]:
    if not REX:
        return []
    try:
        data = run_json([REX, "block", "ls", "-s", session, "--json"])
    except Exception:
        return []
    return data.get("blocks") or []


def rex_process(session: str, block: str) -> dict:
    if not REX:
        return {}
    try:
        data = run_json([REX, "block", "call", "-s", session, "-b", block, "process"])
    except Exception:
        return {}
    return data


RAR_STATE_DIR = Path(os.environ.get("REX_AGENT_RESUME_STATE_DIR") or HOME / ".local/state/rex-agent-resume")


def rex_agent_resume_record(block: str, pid: int | None = None) -> dict | None:
    """The pi session a Rex pane reported to rex-agent-resume, if any.

    Rex exposes no launch command through its API, so this record is the
    equivalent of asking the running pi `/where`. Only trust it while its pid
    still matches the pane's foreground pi.
    """
    if not block:
        return None
    name = block.split(":", 1)[-1]
    try:
        data = json.loads((RAR_STATE_DIR / "agents" / f"block_{name}.json").read_text())
    except Exception:
        return None
    if data.get("agent") != "pi" or not data.get("id"):
        return None
    if data.get("pid") and pid and int(data["pid"]) != int(pid):
        return None
    return data


def load_registry() -> list[dict]:
    records: list[dict] = []
    if not STATE_DIR.is_dir():
        return records
    for path in sorted(STATE_DIR.glob("*.json")):
        try:
            record = json.loads(path.read_text())
        except Exception:
            continue
        record["_path"] = str(path)
        records.append(record)
    return records


def alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        stat = Path(f"/proc/{pid}/stat").read_text().split()
        if len(stat) > 2 and stat[2] == "Z":
            return False
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def proc_env(pid: int | None) -> dict[str, str]:
    if not pid:
        return {}
    try:
        data = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return {}
    out: dict[str, str] = {}
    for item in data:
        if b"=" in item:
            key, value = item.split(b"=", 1)
            out[key.decode(errors="replace")] = value.decode(errors="replace")
    return out


def proc_cwd(pid: int | None) -> str | None:
    if not pid:
        return None
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return None


def proc_ppid(pid: int | None) -> int | None:
    if not pid:
        return None
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().split()[3])
    except Exception:
        return None


def pi_session_file_from_proc(pid: int | None) -> str | None:
    """A native-chat pi is launched by orca-provider-exec with --session."""
    current = pid
    for _ in range(4):
        if not current:
            break
        try:
            argv = Path(f"/proc/{current}/cmdline").read_bytes().split(b"\0")
        except OSError:
            break
        args = [part.decode(errors="replace") for part in argv if part]
        if "--session" in args:
            index = args.index("--session")
            if index + 1 < len(args):
                return args[index + 1]
        current = proc_ppid(current)
    return None


def proc_comm(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


def proc_start_ticks(pid: int | None) -> int | None:
    if not pid:
        return None
    try:
        parts = Path(f"/proc/{pid}/stat").read_text().split()
        return int(parts[21])
    except Exception:
        return None


def pi_pids() -> list[int]:
    try:
        proc = run(["pgrep", "-x", "pi"], timeout=10)
        pids = [int(line) for line in proc.stdout.split() if line.strip().isdigit()]
    except Exception:
        pids = []
    if not pids:
        for path in Path("/proc").glob("[0-9]*"):
            pid = int(path.name)
            if proc_comm(pid) == "pi":
                pids.append(pid)
    return sorted({pid for pid in pids if alive(pid)})


def home_from_env(env: dict[str, str]) -> str:
    # Paseo owns the agent process even when its daemon was started inside a terminal.
    if env.get("PASEO_AGENT_ID"):
        return "paseo"
    # Rex is the innermost terminal when present, then hc, then herdr, then Orca.
    if env.get("REX_BLOCK") or env.get("REX_SESSION"):
        return "rex"
    if env.get("HC_TERMINAL_ID"):
        return "hc"
    if env.get("HERDR_PANE_ID"):
        return "herdr"
    if env.get("ORCA_TAB_ID") or env.get("ORCA_TERMINAL_HANDLE"):
        return "orca"
    if env.get("ORCA_AGENT_SESSION_ID"):
        return "orca"
    return "plain"


def owner_from_env(env: dict[str, str]) -> dict:
    home = home_from_env(env)
    owner: dict = {"kind": home}
    if home == "paseo":
        owner["agent"] = env.get("PASEO_AGENT_ID")
        owner["workspace"] = env.get("PASEO_WORKSPACE_ID")
        owner["cwd"] = env.get("PASEO_AGENT_CWD")
    elif home == "orca":
        if env.get("ORCA_AGENT_SESSION_ID") and not (
            env.get("ORCA_TAB_ID") or env.get("ORCA_TERMINAL_HANDLE")
        ):
            owner["kind"] = "orca-chat"
            owner["session"] = env.get("ORCA_AGENT_SESSION_ID")
            owner["pane"] = env.get("ORCA_PANE_KEY")
        else:
            owner["handle"] = env.get("ORCA_TERMINAL_HANDLE")
            owner["tab"] = env.get("ORCA_TAB_ID")
            owner["pane"] = env.get("ORCA_PANE_KEY")
            owner["worktree"] = env.get("ORCA_WORKTREE_ID")
    elif home == "hc":
        owner["terminal"] = env.get("HC_TERMINAL_ID")
        owner["socket"] = env.get("HC_TERMINAL_SOCKET")
    elif home == "herdr":
        owner["pane"] = env.get("HERDR_PANE_ID")
        owner["tab"] = env.get("HERDR_TAB_ID")
        owner["workspace"] = env.get("HERDR_WORKSPACE_ID")
        owner["socket"] = env.get("HERDR_SOCKET_PATH")
    elif home == "rex":
        owner["block"] = env.get("REX_BLOCK")
        owner["session"] = env.get("REX_SESSION")
        owner["bin_dir"] = env.get("REX_BIN_DIR")
    return owner


def session_id_from_path(path: str | None) -> str | None:
    if not path:
        return None
    match = re.search(
        r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$",
        path,
    )
    return match.group(1) if match else None


def safe_name(text: str, fallback: str = "pi") -> str:
    name = re.sub(r"[^a-z0-9_-]+", "-", (text or "").lower()).strip("-")
    name = re.sub(r"-+", "-", name)[:32].strip("-")
    return name or fallback


def project_of(cwd: str | None) -> str:
    if not cwd:
        return "misc"
    path = Path(cwd)
    if str(path) == str(HOME):
        return "home"
    if str(path) == str(HOME / ".config/mise"):
        return "mise"
    if path.name:
        return path.name
    return "misc"


def current_pids() -> set[int]:
    """Pi pids that belong to this agent/session (the process running the command)."""
    out: set[int] = set()
    pid = os.getpid()
    for _ in range(12):
        try:
            stat = Path(f"/proc/{pid}/stat").read_text().split()
            pid = int(stat[3])
        except Exception:
            break
        if pid <= 1:
            break
        if proc_comm(pid) == "pi":
            out.add(pid)
    return out


def current_owners() -> dict:
    return owner_from_env(os.environ)


def same_owner(record: dict, markers: dict) -> bool:
    owner = record.get("owner") or {}
    kind = owner.get("kind")
    if kind == "orca-chat" and markers.get("kind") == "orca-chat":
        return bool(owner.get("session") and owner.get("session") == markers.get("session"))
    if kind == "orca" and markers.get("kind") == "orca":
        return bool(owner.get("handle") and owner.get("handle") == markers.get("handle")) or bool(
            owner.get("tab") and owner.get("tab") == markers.get("tab")
        )
    if kind == "hc" and markers.get("kind") == "hc":
        return owner.get("terminal") == markers.get("terminal")
    if kind == "herdr" and markers.get("kind") == "herdr":
        return owner.get("pane") == markers.get("pane")
    if kind == "rex" and markers.get("kind") == "rex":
        return owner.get("block") == markers.get("block")
    return False


def record_is_current(record: dict, ancestor_pids: set[int], markers: dict) -> bool:
    return bool((record.get("pid") and int(record["pid"]) in ancestor_pids) or same_owner(record, markers))


def idle(record: dict) -> tuple[bool, str]:
    owner = record.get("owner") or {}
    kind = owner.get("kind")
    if kind == "orca-chat":
        state = record.get("native_chat_state")
        if state == "working":
            return False, "native Orca chat is working"
        return True, f"native Orca chat is {state or 'not running'}"
    if kind == "hc" and HC and owner.get("terminal"):
        proc = run([HC, "read", owner["terminal"]], timeout=30)
        if "INSERT" in proc.stdout[-4000:]:
            return True, "hc screen at INSERT"
        try:
            status = hc_get(owner["terminal"]).get("status") or {}
            if (status.get("app") == "pi") and status.get("state") == "idle":
                return True, "hc pi status idle"
        except Exception:
            pass
        return False, "hc screen not at INSERT"
    if kind == "orca" and ORCA and owner.get("handle"):
        try:
            data = run_json(
                [
                    ORCA,
                    "terminal",
                    "read",
                    "--terminal",
                    owner["handle"],
                    "--screen",
                    "--json",
                ],
                timeout=30,
            )
            tail = ((data.get("result") or {}).get("terminal") or {}).get("tail") or []
            screen = "\n".join(tail)[-4000:]
            if "INSERT" in screen or "NORMAL" in screen:
                return True, "Orca screen at INSERT/NORMAL"
        except Exception:
            pass
        return False, "Orca screen not at INSERT"
    if kind == "rex" and REX and owner.get("session") and owner.get("block"):
        try:
            proc = run(
                [
                    REX,
                    "capture",
                    "-s",
                    owner["session"],
                    "-b",
                    owner["block"],
                    "--trim",
                ],
                timeout=30,
            )
            if "INSERT" in proc.stdout[-4000:]:
                return True, "Rex screen at INSERT"
        except Exception:
            pass
        return False, "Rex screen not at INSERT"
    if kind == "herdr":
        pane_id = owner.get("pane")
        for pane in herdr_snapshot().get("panes") or []:
            if pane.get("pane_id") == pane_id:
                status = pane.get("agent_status")
                if status == "idle":
                    return True, "herdr agent idle"
                return False, f"herdr agent {status or 'unknown'}"
        return False, "herdr pane not found"
    return False, "idle unknown for this owner"


def wait_pid_gone(pid: int | None, timeout: float = 10) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if not alive(pid):
            return True
        time.sleep(0.2)
    return not alive(pid)


def orca_runtime_metadata() -> dict:
    """Read the live Orca runtime record (runtime id, socket and auth token)."""
    roots = []
    for key in ("ORCA_USER_DATA_PATH", "ORCA_USER_DATA"):
        value = os.environ.get(key)
        if value:
            roots.append(Path(value).expanduser())
    roots.append(HOME / ".config/orca")
    for root in roots:
        path = root / "orca-runtime.json"
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if data.get("transports"):
            return data
    raise RuntimeError("no Orca runtime metadata; is the Orca app running?")


def canonicalize(value) -> str:
    """Canonical JSON used by Orca's create-intent fingerprint."""
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    entries = sorted((key, item) for key, item in value.items() if item is not None)
    return "{" + ",".join(json.dumps(key) + ":" + canonicalize(item) for key, item in entries) + "}"


def orca_rpc(method: str, params: dict, timeout: int = 30) -> dict:
    """Call one method on the live Orca runtime socket.

    The CLI does not expose these app RPCs, so use the runtime metadata that
    Orca rewrites on every restart.  Never cache its socket or auth token.
    """
    metadata = orca_runtime_metadata()
    transport = next(
        (item for item in metadata.get("transports") or [] if item.get("kind") == "unix"),
        None,
    )
    if not transport or not transport.get("endpoint"):
        raise RuntimeError("no Orca unix runtime transport")
    request_id = str(uuid.uuid4())
    request = {
        "id": request_id,
        "authToken": metadata.get("authToken"),
        "method": method,
        "params": params,
    }
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(transport["endpoint"])
        sock.sendall((json.dumps(request) + "\n").encode())
        buffer = b""
        while b"\n" not in buffer:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buffer += chunk
    line = buffer.split(b"\n", 1)[0].strip()
    if not line:
        raise RuntimeError("Orca runtime returned no response")
    response = json.loads(line)
    if response.get("id") not in (None, request_id):
        raise RuntimeError("Orca runtime returned another request's response")
    return response


def _orca_rpc_refusal(response: dict) -> dict:
    result = response.get("result") or {}
    if result.get("ok") is False:
        return result.get("refusal") or {"code": "agent_session_refused"}
    return response.get("error") or {"code": "agent_session_refused"}


def orca_chat_close(session_id: str) -> tuple[bool, str]:
    """Close a native Orca chat tab through its runtime RPC."""
    if not session_id:
        return False, "no Orca chat session id"
    try:
        response = orca_rpc("agentSession.close", {"sessionId": session_id})
    except Exception as exc:
        return False, f"Orca chat close RPC failed: {exc}"
    if response.get("ok") is True and (response.get("result") or {}).get("ok") is not False:
        return True, "closed Orca chat tab"
    return False, str(_orca_rpc_refusal(response))[:300]


def orca_chat_reveal(session_id: str) -> tuple[bool, dict | str]:
    """Reopen an existing native Orca chat record, exactly as /resume does."""
    if not session_id:
        return False, "no Orca chat session id"
    try:
        response = orca_rpc("agentSession.reveal", {"sessionId": session_id})
    except Exception as exc:
        return False, f"Orca chat reveal RPC failed: {exc}"
    result = response.get("result") or {}
    if response.get("ok") is True and result.get("ok") is True:
        return True, {
            "chat": result.get("sessionId") or session_id,
            "kind": "native-chat",
            "revealed": True,
        }
    return False, _orca_rpc_refusal(response)


def orca_chat_create_or_reveal(provider_session_id: str, worktree: str) -> tuple[bool, dict | str]:
    """Resume a pi conversation into Orca, matching the desktop /resume logic.

    First try `agentSession.create` with `resumeFrom`.  If a dormant native
    chat still owns that provider conversation, Orca refuses with
    `conversationHeldElsewhere`; reveal that owner instead of creating a
    second chat.  This is the same fallback the desktop Session History uses.
    """
    if not provider_session_id:
        return False, "no pi provider session id"
    session_id = "pi_" + uuid.uuid4().hex
    client_operation_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex}"
    fields = {
        "worktree": worktree,
        "agent": "pi",
        "resumeFrom": {"providerSessionId": provider_session_id},
    }
    fingerprint = hashlib.sha256(
        canonicalize(
            {
                "method": "agentSession.create",
                "sessionId": session_id,
                "fields": fields,
            }
        ).encode()
    ).hexdigest()
    params = {
        "envelope": {
            "sessionId": session_id,
            "clientOperationId": client_operation_id,
            "expectedRuntimeFence": None,
            "payloadFingerprint": fingerprint,
        },
        **fields,
    }
    try:
        response = orca_rpc("agentSession.create", params, timeout=60)
    except Exception as exc:
        return False, f"Orca chat create RPC failed: {exc}"
    result = response.get("result") or {}
    if response.get("ok") is True and result.get("ok") is True:
        return True, {
            "chat": result.get("sessionId") or session_id,
            "kind": "native-chat",
            "created": True,
        }
    refusal = _orca_rpc_refusal(response)
    owner = (refusal.get("details") or {}).get("owner") or {}
    if owner.get("sessionId"):
        ok, detail = orca_chat_reveal(owner["sessionId"])
        if ok:
            return True, {**detail, "revealed": True, "owner": owner}
        return False, f"owner chat reveal failed: {detail}"
    return False, refusal


def stop_owner(record: dict, allow_plain: bool = False, allow_native_chat: bool = False) -> tuple[bool, str]:
    owner = record.get("owner") or {}
    kind = owner.get("kind")
    pid = record.get("pid")
    if kind == "paseo":
        agent_id = owner.get("agent")
        archived_ok = True
        archive_error = ""
        if PASEO and agent_id:
            run([PASEO, "stop", agent_id, "--json"], timeout=30)
            archived = run([PASEO, "archive", agent_id, "--force", "--json"], timeout=30)
            archived_ok = archived.returncode == 0
            if not archived_ok:
                archive_error = archived.stderr.strip()[:300] or "paseo archive failed"
        if not archived_ok:
            return False, archive_error
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                return True, "archived Paseo agent"
            if wait_pid_gone(pid):
                return True, "archived Paseo agent"
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                return True, "archived Paseo agent"
            gone = wait_pid_gone(pid)
            return gone, "archived Paseo agent" if gone else "archived Paseo agent but pi survived"
        return True, "archived Paseo agent"
    if kind == "orca-chat":
        if not allow_native_chat:
            return False, "native Orca chat; pass --allow-native-chat"
        session_id = owner.get("session")
        # Orca's renderer RPC already retires the tab; the CLI only lacks the wrapper.
        if session_id:
            closed, detail = orca_chat_close(session_id)
            if closed:
                gone = wait_pid_gone(pid) if pid else True
                if gone:
                    return True, "closed Orca chat tab"
                # Tab is gone; finish a lingering provider so it cannot own the file twice.
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    return True, "closed Orca chat tab"
                if wait_pid_gone(pid):
                    return True, "closed Orca chat tab"
        # Future Orca CLI (PR #39918): close the chat tab as well as the agent.
        if ORCA and session_id:
            proc = run(
                [ORCA, "chat", "close", "--session", session_id, "--json"],
                timeout=30,
            )
            if proc.returncode == 0 and (not pid or wait_pid_gone(pid)):
                return True, "closed Orca chat"
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                return True, "stopped native-chat pi; close the Orca chat tab"
            gone = wait_pid_gone(pid)
            return gone, (
                "stopped native-chat pi; close the Orca chat tab"
                if gone
                else "native-chat pi survived; close the Orca chat tab"
            )
        return True, "native chat is not running; close the Orca chat tab"
    if kind == "orca" and ORCA and owner.get("handle"):
        proc = run(
            [
                ORCA,
                "terminal",
                "close",
                "--terminal",
                owner["handle"],
                "--tab",
                "--json",
            ],
            timeout=60,
        )
        if proc.returncode != 0:
            return False, proc.stderr.strip()[:300] or "Orca close failed"
        gone = wait_pid_gone(pid)
        if not gone and pid:
            # Orca can close the tab while its PTY child survives; the tab is gone, so
            # finish the stop so a destination cannot become a second owner.
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                gone = True
            if not gone:
                gone = wait_pid_gone(pid)
            if not gone:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    gone = True
                gone = wait_pid_gone(pid) or gone
        return gone, "closed Orca tab" if gone else "Orca pid survived"

    if kind == "hc" and HC and owner.get("terminal"):
        proc = run([HC, "kill", owner["terminal"], "--json"], timeout=30)
        if proc.returncode != 0:
            return False, proc.stderr.strip()[:300] or "hc kill failed"
        return (wait_pid_gone(pid), "killed hc terminal")
    if kind == "herdr" and HERDR and owner.get("pane"):
        proc = run([HERDR, "pane", "close", owner["pane"]], timeout=30)
        if proc.returncode != 0:
            return False, proc.stderr.strip()[:300] or "herdr pane close failed"
        return (wait_pid_gone(pid), "closed herdr pane")
    if kind == "rex" and REX and owner.get("session") and owner.get("block"):
        proc = run(
            [REX, "block", "close", "-s", owner["session"], owner["block"]],
            timeout=30,
        )
        if proc.returncode != 0:
            return False, proc.stderr.strip()[:300] or "Rex block close failed"
        return (wait_pid_gone(pid), "closed Rex block")
    if kind == "plain" and allow_plain and pid:
        try:
            os.kill(pid, 15)
        except OSError as exc:
            return False, str(exc)
        return (wait_pid_gone(pid), "sent SIGTERM")
    return False, f"cannot stop owner {kind}"


def _pi_command(file: str) -> str:
    return f"pi --session {shlex_quote(file)}"


def shlex_quote(text: str) -> str:
    return "'" + text.replace("'", "'\\''") + "'"


def unique_hc_name(base: str, existing: set[str]) -> str:
    name = safe_name(base)[:32] or "pi"
    if name not in existing:
        return name
    for index in range(2, 100):
        suffix = f"-{index}"
        candidate = (name[: 32 - len(suffix)] + suffix).strip("-")
        if candidate not in existing:
            return candidate
    raise RuntimeError("could not make a unique hc name")


def start_hc(record: dict, name: str | None = None) -> tuple[bool, dict | str]:
    if not HC:
        return False, "hc is not on PATH"
    file = record.get("session_file")
    if not file:
        return False, "no pi session file"
    names = {t.get("name") for t in hc_terms() if t.get("name")}
    source_title = (record.get("title") or "").strip()
    name = name or unique_hc_name(
        safe_name(source_title)
        if source_title
        else f"{project_of(record.get('cwd'))}-{(record.get('session_id') or 'pi')[-8:]}",
        names,
    )
    labels = [
        "--label",
        f"from={record.get('owner', {}).get('kind', 'unknown')}",
        "--label",
        f"sync.pi={file}",
    ]
    if source_title:
        labels += ["--label", f"sync.title={source_title}"]
    if record.get("session_id"):
        labels += ["--label", f"sync.session={record['session_id']}"]
    cmd = [
        HC,
        "run",
        "--bg",
        "--keep",
        "--no-parent",
        "--name",
        name,
        "--cwd",
        record.get("cwd") or str(HOME),
        *labels,
        "--json",
        "--",
        PI or "pi",
        "--session",
        file,
    ]
    proc = run(cmd, timeout=60)
    if proc.returncode != 0:
        return False, proc.stderr.strip()[:400] or "hc run failed"
    try:
        data = json_from_text(proc.stdout)
    except Exception:
        return False, f"hc run returned no JSON: {proc.stdout[:300]}"
    address = data.get("address")
    if not address:
        return False, f"hc run returned no address: {data}"
    end = time.time() + 12
    while time.time() < end:
        try:
            current = hc_get(address)
        except Exception:
            time.sleep(0.4)
            continue
        fg = current.get("foreground") or {}
        argv = fg.get("argv") or []
        if fg.get("name") in ("pi", "node") or (argv and argv[0] == "pi"):
            return True, {"address": address, "name": name, "foreground": fg}
        time.sleep(0.4)
    return False, {
        "address": address,
        "name": name,
        "error": "pi did not become foreground",
    }


def start_rex(
    record: dict, session_label: str | None = None, window_label: str | None = None
) -> tuple[bool, dict | str]:
    if not REX:
        return False, "rex is not on PATH"
    file = record.get("session_file")
    if not file:
        return False, "no pi session file"
    cwd = record.get("cwd") or str(HOME)
    session_label = session_label or project_of(cwd)
    window_label = window_label or record.get("title") or session_label
    terminal = (record.get("owner") or {}).get("terminal")
    if terminal and terminal not in window_label:
        window_label = f"{window_label} · {terminal}"
    sessions = {s.get("label"): s.get("session_id") for s in rex_sessions()}
    sid = sessions.get(session_label)
    if sid:
        cmd = [
            REX,
            "window",
            "new",
            "-s",
            sid,
            window_label,
            "-c",
            cwd,
            "--interactive",
            "--json",
            "--",
            PI or "pi",
            "--session",
            file,
        ]
    else:
        cmd = [
            REX,
            "new",
            session_label,
            "-c",
            cwd,
            "--window",
            window_label,
            "--interactive",
            "--json",
            "--",
            PI or "pi",
            "--session",
            file,
        ]
    proc = run(cmd, timeout=60)
    if proc.returncode != 0:
        return False, proc.stderr.strip()[:400] or "rex create failed"
    try:
        data = json_from_text(proc.stdout)
    except Exception:
        return False, f"rex returned no JSON: {proc.stdout[:300]}"
    if sid:
        block = (data.get("block_ids") or [None])[0]
    else:
        sid = data.get("session_id")
        block = ((data.get("initial_windows") or [{}])[0].get("block_ids") or [None])[0]
    if not sid or not block:
        return False, f"rex returned no session/block: {data}"
    run([REX, "block", "rename", "-s", sid, block, window_label], timeout=30)
    end = time.time() + 12
    while time.time() < end:
        fg = rex_process(sid, block).get("foreground") or {}
        if fg.get("argv0") == "pi" or fg.get("name") == "pi":
            return True, {
                "session": sid,
                "block": block,
                "label": window_label,
                "foreground": fg,
            }
        time.sleep(0.5)
    return False, {
        "session": sid,
        "block": block,
        "error": "pi did not become foreground",
    }


def start_paseo(record: dict, title: str | None = None) -> tuple[bool, dict | str]:
    if not PASEO:
        return False, "Paseo CLI not found (set PASEO_CLI_COMMAND)"
    file = record.get("session_file")
    if not file:
        return False, "no pi session file"
    provider_session = record.get("session_id") or session_id_from_path(file)
    if not provider_session:
        return False, "no pi provider session id"
    cwd = record.get("cwd") or str(HOME)
    proc = run(
        [
            PASEO,
            "import",
            provider_session,
            "--provider",
            "pi",
            "--cwd",
            cwd,
            "--json",
        ],
        timeout=120,
    )
    if proc.returncode != 0:
        return False, proc.stderr.strip()[:400] or "paseo import failed"
    try:
        data = json_from_text(proc.stdout)
    except Exception:
        return False, f"Paseo returned no JSON: {proc.stdout[:300]}"
    result = data.get("result") or data
    agent_id = result.get("id") or result.get("agentId") or result.get("agent", {}).get("id")
    if not agent_id:
        return False, f"Paseo returned no agent id: {data}"
    label = title or record.get("title")
    if label:
        run([PASEO, "agent", "update", agent_id, "--name", label, "--json"], timeout=30)
    return True, {"agent": agent_id, "kind": "paseo", "provider": "pi"}


def start_orca(
    record: dict,
    title: str | None = None,
    add_repo: bool = False,
    native_chat: bool = False,
) -> tuple[bool, dict | str]:
    if not ORCA:
        return False, "Orca CLI not found (set ORCA_CLI_COMMAND)"
    file = record.get("session_file")
    if not file:
        return False, "no pi session file"
    cwd = record.get("cwd") or str(HOME)
    known = orca_worktrees()
    if cwd not in known.values() and not add_repo:
        return (
            False,
            f"{cwd} is not an Orca worktree; pass --add-repo or use another destination",
        )
    if add_repo:
        proc = run([ORCA, "repo", "add", "--path", cwd, "--json"], timeout=60)
        if proc.returncode != 0:
            return False, proc.stderr.strip()[:300] or "orca repo add failed"
    if native_chat:
        known = orca_worktrees()
        worktree_id = next((wid for wid, path in known.items() if path == cwd), None)
        if not worktree_id:
            return False, f"{cwd} is not an Orca worktree; pass --add-repo"
        provider = record.get("session_id") or session_id_from_path(file)
        ok, detail = orca_chat_create_or_reveal(provider, f"id:{worktree_id}")
        if not ok:
            return False, f"native chat failed: {detail}"
        label = title or record.get("title")
        if label and detail.get("chat"):
            run(
                [ORCA, "chat", "rename", "--session", detail["chat"], "--name", label, "--json"],
                timeout=30,
            )
        return True, detail
    command = _pi_command(file)
    proc = run(
        [
            ORCA,
            "terminal",
            "create",
            "--worktree",
            f"path:{cwd}",
            "--title",
            title or record.get("title") or Path(cwd).name,
            "--command",
            command,
            "--json",
        ],
        timeout=60,
    )
    if proc.returncode != 0:
        return False, proc.stderr.strip()[:400] or "orca terminal create failed"
    try:
        data = json_from_text(proc.stdout)
    except Exception:
        return False, f"Orca returned no JSON: {proc.stdout[:300]}"
    result = data.get("result") or data
    handle = (
        result.get("terminal", {}).get("handle")
        if isinstance(result.get("terminal"), dict)
        else result.get("handle")
    )
    tab = (
        result.get("terminal", {}).get("tabId")
        if isinstance(result.get("terminal"), dict)
        else result.get("tabId")
    )
    if not handle:
        return False, f"Orca returned no terminal handle: {data}"
    end = time.time() + 12
    while time.time() < end:
        for candidate in orca_terms():
            if candidate.get("handle") == handle and candidate.get("agentIdentity") == "pi":
                return True, {
                    "handle": handle,
                    "tab": candidate.get("tabId") or tab,
                    "command": command,
                }
        time.sleep(0.5)
    return False, {
        "handle": handle,
        "tab": tab,
        "error": "Orca did not report agentIdentity pi",
    }


def start_herdr(
    record: dict, workspace: str | None = None, label: str | None = None
) -> tuple[bool, dict | str]:
    if not HERDR:
        return False, "herdr is not on PATH"
    file = record.get("session_file")
    if not file:
        return False, "no pi session file"
    snapshot = herdr_snapshot()
    if not snapshot:
        return False, "herdr snapshot unavailable"
    workspace = workspace or snapshot.get("focused_workspace_id")
    if not workspace:
        workspaces = snapshot.get("workspaces") or []
        workspace = workspaces[0].get("workspace_id") if workspaces else None
    if not workspace:
        return False, "no herdr workspace"
    before = {p.get("pane_id") for p in snapshot.get("panes") or []}
    label = label or record.get("title") or project_of(record.get("cwd"))
    proc = run(
        [
            HERDR,
            "tab",
            "create",
            "--workspace",
            workspace,
            "--label",
            label,
            "--cwd",
            record.get("cwd") or str(HOME),
            "--no-focus",
        ],
        timeout=30,
    )
    if proc.returncode != 0:
        return False, proc.stderr.strip()[:300] or "herdr tab create failed"
    after = herdr_snapshot()
    new_panes = [
        p.get("pane_id")
        for p in after.get("panes") or []
        if p.get("pane_id") and p.get("pane_id") not in before
    ]
    if not new_panes:
        return False, "new herdr pane not found"
    pane = new_panes[-1]
    proc = run(
        [
            HERDR,
            "agent",
            "start",
            label,
            "--kind",
            "pi",
            "--pane",
            pane,
            "--",
            "--session",
            file,
        ],
        timeout=60,
    )
    if proc.returncode != 0:
        return False, proc.stderr.strip()[:400] or "herdr agent start failed"
    end = time.time() + 12
    while time.time() < end:
        current = herdr_snapshot()
        for candidate in current.get("panes") or []:
            if candidate.get("pane_id") != pane:
                continue
            session = candidate.get("agent_session") or {}
            if candidate.get("agent") == "pi" or session.get("value") == file:
                return True, {"pane": pane, "workspace": workspace, "label": label}
        time.sleep(0.5)
    return False, {
        "pane": pane,
        "workspace": workspace,
        "label": label,
        "error": "herdr did not report pi in the pane",
    }
