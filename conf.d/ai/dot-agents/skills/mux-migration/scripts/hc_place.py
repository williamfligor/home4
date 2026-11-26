#!/usr/bin/env python3
"""Place herdr-core (hc) terminals in the herdr-app layout document.

The app only draws terminals that carry herdr.space/herdr.tab labels naming a
space/tab in the `herdr-app` document. Terminals without them are hidden from
the layout, even though `hc ls` sees them.

This tool is idempotent: it reuses an existing space for a folder, merges
duplicate spaces for the same folder, adds one tab per terminal, and then
updates the terminal labels. It is read-only unless --apply is passed.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import muxlib as m


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:32]


def space_id(folder: str) -> str:
    return "sp" + digest(folder)


def tab_id(space: str, name: str) -> str:
    return "tb" + digest(space + "\0" + name)


def block_id(tab: str, terminal: str) -> str:
    return "p" + digest(tab + "\0" + terminal)


def tab_object(tid: str, name: str, terminal: str) -> dict:
    return {
        "id": tid,
        "name": name,
        "root": {
            "id": tid,
            "type": "row",
            "children": [
                {
                    "id": block_id(tid, terminal),
                    "type": "block",
                    "content": {"terminal": terminal},
                }
            ],
        },
    }


def folder_name(folder: str) -> str:
    return m.project_of(folder)


def merge_duplicate_spaces(doc: dict) -> tuple[dict[str, str], list[str]]:
    """Merge spaces that point at the same folder; the app shows only one per folder."""
    spaces = doc.setdefault("spaces", [])
    by_folder: dict[str, list[dict]] = {}
    for space in spaces:
        folder = space.get("folder")
        if folder:
            by_folder.setdefault(folder, []).append(space)
    remap: dict[str, str] = {}
    notes: list[str] = []
    for folder, group in by_folder.items():
        if len(group) < 2:
            continue
        keep = next((space for space in group if space.get("name")), group[0])
        for other in group:
            if other is keep:
                continue
            remap[other.get("id")] = keep.get("id")
            for tab in other.get("tabs", []):
                if not any(existing.get("id") == tab.get("id") for existing in keep.setdefault("tabs", [])):
                    keep.setdefault("tabs", []).append(tab)
            spaces.remove(other)
            notes.append(f"merge duplicate space {other.get('id')} into {keep.get('id')}")
        if not keep.get("name"):
            keep["name"] = folder_name(folder)
    return remap, notes


def space_for(doc: dict, folder: str, name: str) -> tuple[dict, dict[str, str], list[str]]:
    """Return the space for folder, a remap of duplicate space ids, and notes."""
    spaces = doc.setdefault("spaces", [])
    matches = [space for space in spaces if space.get("folder") == folder]
    notes: list[str] = []
    remap: dict[str, str] = {}
    if not matches:
        space = {"id": space_id(folder), "name": name, "folder": folder, "tabs": []}
        spaces.append(space)
        notes.append(f"create space {name!r} ({space['id']})")
        return space, remap, notes
    # Prefer the first space that already has a name, otherwise the first.
    keep = next((space for space in matches if space.get("name")), matches[0])
    if not keep.get("name"):
        keep["name"] = name
        notes.append(f"name space {keep['id']} {name!r}")
    if not keep.get("folder"):
        keep["folder"] = folder
    for other in matches:
        if other is keep:
            continue
        remap[other.get("id")] = keep.get("id")
        for tab in other.get("tabs", []):
            if not any(existing.get("id") == tab.get("id") for existing in keep.setdefault("tabs", [])):
                keep["tabs"].append(tab)
        spaces.remove(other)
        notes.append(f"merge duplicate space {other.get('id')} into {keep.get('id')}")
    return keep, remap, notes


def tab_terminals(tab: dict) -> list[str]:
    out: list[str] = []

    def walk(node):
        if (node.get("content") or {}).get("terminal"):
            out.append(node["content"]["terminal"])
        for child in node.get("children") or []:
            walk(child)

    walk(tab.get("root") or {})
    return out


def find_terminal_tab(doc: dict, address: str) -> tuple[dict, dict] | None:
    for space in doc.get("spaces", []):
        for tab in space.get("tabs", []):
            if address in tab_terminals(tab):
                return space, tab
    return None


def add_terminal(doc: dict, terminal: dict, remap: dict[str, str], notes: list[str]) -> dict:
    address = terminal.get("address")
    labels = terminal.get("labels") or {}
    cwd = terminal.get("cwd")
    if not address or not cwd:
        raise ValueError("terminal has no address/cwd")
    display_name = labels.get("sync.title") or terminal.get("name") or terminal.get("title") or address
    found = find_terminal_tab(doc, address)
    if found is not None:
        space, tab = found
        if not space.get("name"):
            space["name"] = folder_name(space.get("folder") or cwd)
        if not space.get("folder"):
            space["folder"] = cwd
        if not tab.get("name"):
            tab["name"] = display_name
        where = f"{space.get('name') or folder_name(cwd)} / {tab.get('name') or address}"
        notes.append(f"reuse existing tab {tab.get('name')!r} for {address}")
        return {
            "space": space["id"],
            "tab": tab["id"],
            "where": where,
            "remap": remap,
            "notes": notes,
        }
    space, local_remap, local_notes = space_for(doc, cwd, folder_name(cwd))
    remap.update(local_remap)
    notes.extend(local_notes)
    tab_name = display_name
    tab = None
    existing_tab_id = labels.get("herdr.tab")
    if existing_tab_id:
        tab = next(
            (item for item in space.setdefault("tabs", []) if item.get("id") == existing_tab_id),
            None,
        )
    if tab is None:
        tab = next(
            (item for item in space.setdefault("tabs", []) if item.get("name") == tab_name),
            None,
        )
    if tab is None:
        tid = tab_id(space["id"], tab_name)
        tab = next((item for item in space["tabs"] if item.get("id") == tid), None)
        if tab is None:
            tab = tab_object(tid, tab_name, address)
            space["tabs"].append(tab)
            notes.append(f"add tab {tab_name!r} ({tid}) -> {address}")
    else:
        children = tab.setdefault("root", {}).setdefault("children", [])
        if not any((child.get("content") or {}).get("terminal") == address for child in children):
            children.append(
                {
                    "id": block_id(tab["id"], address),
                    "type": "block",
                    "content": {"terminal": address},
                }
            )
            notes.append(f"add {address} to tab {tab.get('name')!r}")
    where = f"{space.get('name') or folder_name(cwd)} / {tab.get('name') or tab_name}"
    return {
        "space": space["id"],
        "tab": tab["id"],
        "where": where,
        "remap": remap,
        "notes": notes,
    }


def read_doc(name: str) -> tuple[dict, int]:
    try:
        got = m.hc_call("doc.get", {"name": name})
    except Exception:
        return {"spaces": []}, 0
    return got.get("value") or {"spaces": []}, got.get("version", 0)


def write_doc(name: str, build) -> tuple[int, dict]:
    last_error: Exception | None = None
    for _ in range(10):
        doc, version = read_doc(name)
        value, plan = build(copy.deepcopy(doc))
        try:
            result = m.hc_call("doc.set", {"name": name, "value": value, "version": version})
            return int(result.get("version", version + 1)), plan
        except Exception as exc:
            last_error = exc
            if "conflict" not in str(exc).lower():
                raise
            time.sleep(0.5)
    raise RuntimeError(f"could not write {name}: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write the doc and labels (default: dry run)",
    )
    parser.add_argument("--doc", default=m.DOC_NAME)
    parser.add_argument("--socket", help="HC_SOCKET to use")
    parser.add_argument("--terminal", action="append", help="only these hc addresses")
    parser.add_argument("--folder", action="append", help="only terminals under this folder")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.socket:
        os.environ["HC_SOCKET"] = args.socket
        m.HC = m.HC or "hc"

    terminals = []
    for term in m.hc_terms():
        if term.get("state") != "live":
            continue
        address = term.get("address")
        if args.terminal and address not in args.terminal:
            continue
        if args.folder and not str(term.get("cwd") or "").startswith(tuple(args.folder)):
            continue
        if not term.get("cwd"):
            continue
        terminals.append(term)
    if not terminals:
        print("no live hc terminals with a cwd")
        return 0

    def build(doc: dict):
        notes: list[str] = []
        assignments: dict[str, dict] = {}
        remap, merge_notes = merge_duplicate_spaces(doc)
        notes.extend(merge_notes)
        for term in terminals:
            address = term.get("address")
            labels = term.get("labels") or {}
            space = labels.get("herdr.space")
            tab = labels.get("herdr.tab")
            valid = False
            if space and tab:
                for candidate in doc.get("spaces", []):
                    if candidate.get("id") == space and any(
                        t.get("id") == tab for t in candidate.get("tabs", [])
                    ):
                        valid = True
                        break
            if valid:
                continue
            try:
                assignment = add_terminal(doc, term, remap, notes)
            except Exception as exc:
                notes.append(f"skip {address}: {exc}")
                continue
            assignments[address] = assignment
        return doc, {"assignments": assignments, "remap": remap, "notes": notes}

    if not args.apply:
        _, plan = build(copy.deepcopy(read_doc(args.doc)[0]))
        print(json.dumps(plan, indent=2) if args.json else "\n".join(plan["notes"]) or "nothing to place")
        return 0

    new_version, plan = write_doc(args.doc, build)
    print(f"wrote {args.doc} version {new_version}")
    for address, assignment in plan["assignments"].items():
        command = [
            m.HC,
            "label",
            address,
            f"herdr.space={assignment['space']}",
            f"herdr.tab={assignment['tab']}",
            f"where={assignment['where']}",
        ]
        proc = m.run(command, timeout=30)
        if proc.returncode != 0:
            print(f"label {address} failed: {proc.stderr.strip()[:200]}")
        else:
            print(f"placed {address} at {assignment['where']}")
    for note in plan["notes"]:
        print(note)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
