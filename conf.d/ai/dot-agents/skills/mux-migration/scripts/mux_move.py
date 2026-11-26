#!/usr/bin/env python3
"""Move live pi sessions between Orca, Paseo, herdr-core (hc), herdr, and Rex.

Dry-run by default. On --apply, every selected session is stopped at its current
owner(s) and restarted with `pi --session <file>` at the destination. Exactly one
owner is allowed; the current session (the one running this command) is skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import muxlib as m
import mux_inventory as inventory


def key_of(record: dict) -> str:
    return record.get("session_id") or record.get("session_file") or f"pid:{record.get('pid')}"


def owner_text(record: dict) -> str:
    owner = record.get("owner") or {}
    kind = owner.get("kind")
    if kind == "orca-chat":
        return f"orca-chat:{(owner.get('session') or '?')[-8:]}"
    if kind == "orca":
        return f"orca:{(owner.get('tab') or owner.get('handle') or '?')[-8:]}"
    if kind == "paseo":
        return f"paseo:{(owner.get('agent') or '?')[:8]}"
    if kind == "hc":
        return f"hc:{owner.get('terminal')}"
    if kind == "herdr":
        return f"herdr:{owner.get('pane')}"
    if kind == "rex":
        return f"rex:{(owner.get('session') or '')[-8:]}:{(owner.get('block') or '')[-8:]}"
    return kind or "?"


def select(records: list[dict], args) -> list[dict]:
    eligible = [
        record
        for record in records
        if record.get("alive") or (args.allow_native_chat and record.get("native_chat"))
    ]
    if args.source != "any":
        eligible = [record for record in eligible if record.get("home") == args.source]
    if args.session:
        wanted = set(args.session)
        selected = []
        for record in eligible:
            owner = record.get("owner") or {}
            candidates = {
                str(record.get("session_id") or ""),
                str(record.get("session_file") or ""),
                str(record.get("pid") or ""),
                str(owner.get("session") or ""),
            }
            if any(
                value and any(value == item or value.startswith(item) for item in wanted)
                for value in candidates
            ):
                selected.append(record)
    else:
        selected = eligible if args.all else []
    # Include every owner of a selected session, even when --from names one runtime.
    keys = {key_of(record) for record in selected}
    for record in records:
        if key_of(record) in keys and record not in selected:
            selected.append(record)
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--from",
        dest="source",
        choices=["orca", "paseo", "hc", "herdr", "rex", "any"],
        default="any",
    )
    parser.add_argument("--to", dest="dest", choices=["orca", "paseo", "hc", "herdr", "rex"], required=True)
    parser.add_argument(
        "--session",
        action="append",
        help="session id/prefix, jsonl path, or pid; repeatable",
    )
    parser.add_argument("--all", action="store_true", help="select every live pi session from --from")
    parser.add_argument("--apply", action="store_true", help="perform the move (default: dry run)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="move non-idle sessions and duplicate owners",
    )
    parser.add_argument(
        "--allow-pending",
        action="store_true",
        help="allow a session file that pi has not written yet",
    )
    parser.add_argument("--allow-plain", action="store_true", help="SIGTERM a plain-terminal owner")
    parser.add_argument(
        "--allow-native-chat",
        action="store_true",
        help="stop a native Orca chat's pi; its chat tab must be closed in Orca",
    )
    parser.add_argument(
        "--add-repo",
        action="store_true",
        help="let Orca add a folder as a repo (visible sidebar change)",
    )
    parser.add_argument("--rex-session", help="destination Rex session label (default: project folder)")
    parser.add_argument("--rex-window", help="destination Rex window label (default: session title)")
    parser.add_argument("--herdr-workspace", help="destination herdr workspace id")
    parser.add_argument("--orca-title", help="destination Orca tab title")
    parser.add_argument(
        "--orca-native-chat",
        action="store_true",
        help="resume into Orca Chat UI instead of a terminal (reveals an existing owner chat)",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    records = inventory.build()
    selected = select(records, args)
    if not selected:
        if args.json:
            print(json.dumps({"selected": [], "records": records}, indent=2))
        else:
            print(inventory.table(records))
            print("\nNo matching live pi sessions. Use --session <id|file|pid> or --all.")
        return 0

    groups: dict[str, list[dict]] = {}
    for record in selected:
        groups.setdefault(key_of(record), []).append(record)

    plans = []
    for key, group in groups.items():
        owners = [owner_text(record) for record in group]
        current = any(record.get("current") for record in group)
        file = next(
            (record.get("session_file") for record in group if record.get("session_file")),
            None,
        )
        reason = None
        if current:
            reason = "current/in-use session"
        elif not file:
            reason = "no session file (Orca/Rex without a registry match)"
        elif not Path(file).exists() and not args.allow_pending:
            reason = "session file missing (use --allow-pending)"
        elif len(group) > 1 and not args.force:
            reason = f"{len(group)} owners (use --force to stop them all)"
        elif (
            len(group) == 1
            and group[0].get("home") != args.source
            and args.source != "any"
            and not args.force
        ):
            reason = f"owner is {group[0].get('home')}, not --from {args.source}"
        elif (
            any((record.get("owner") or {}).get("kind") == "orca-chat" for record in group)
            and not args.allow_native_chat
        ):
            reason = "native Orca chat (use --allow-native-chat; close its tab in Orca)"
        idle = None
        if reason is None:
            idle, detail = m.idle(group[0])
            if not idle and not args.force:
                reason = f"not idle ({detail}; use --force)"
        plans.append(
            {
                "key": key,
                "group": group,
                "owners": owners,
                "current": current,
                "file": file,
                "idle": idle,
                "reason": reason,
            }
        )

    if not args.apply:
        if args.json:
            print(json.dumps({"plans": plans}, indent=2, default=str))
        else:
            print(f"dry run: {args.source} -> {args.dest}; pass --apply to execute")
            for plan in plans:
                status = "READY" if not plan["reason"] else f"SKIP: {plan['reason']}"
                print(f"  {plan['key'][-12:]:12}  {', '.join(plan['owners']):40}  {status}")
                if plan["file"]:
                    print(f"      {plan['file']}")
        return 0

    failures = []
    results = []
    for plan in plans:
        if plan["reason"]:
            failures.append((plan["key"], plan["reason"]))
            continue
        group = plan["group"]
        # Stop every live owner before starting the destination.
        stopped = []
        for record in group:
            ok, detail = m.stop_owner(
                record,
                allow_plain=args.allow_plain,
                allow_native_chat=args.allow_native_chat,
            )
            stopped.append((owner_text(record), ok, detail))
            if not ok:
                break
        if any(not ok for _, ok, _ in stopped):
            failures.append((plan["key"], f"stop failed: {stopped}"))
            continue
        record = group[0]
        try:
            if args.dest == "paseo":
                result = m.start_paseo(record)
            elif args.dest == "hc":
                result = m.start_hc(record)
            elif args.dest == "rex":
                result = m.start_rex(
                    record,
                    session_label=args.rex_session,
                    window_label=args.rex_window,
                )
            elif args.dest == "orca":
                result = m.start_orca(
                    record,
                    title=args.orca_title,
                    add_repo=args.add_repo,
                    native_chat=args.orca_native_chat,
                )
            else:
                result = m.start_herdr(record, workspace=args.herdr_workspace)
        except Exception as exc:
            result = (False, str(exc))
        ok, detail = result
        results.append({"key": plan["key"], "stopped": stopped, "started": ok, "detail": detail})
        if not ok:
            failures.append((plan["key"], f"start failed: {detail}"))

    if args.json:
        print(json.dumps({"results": results, "failures": failures}, indent=2, default=str))
    else:
        for result in results:
            print(
                f"{result['key'][-12:]:12}  "
                f"{'started' if result['started'] else 'FAILED'}  {result['detail']}"
            )
        if failures:
            print("\nfailures:")
            for key, reason in failures:
                print(f"  {key[-12:]}: {reason}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
