// -----------------------------------------------------------------------------
// Source:  https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/uv.ts
// Origin:  https://github.com/mitsuhiko/agent-stuff
// Commit:  401fa86  (approx. 2026-03-14)
// SPDX-FileCopyrightText: Armin Ronacher <armin.ronacher@active-4.com>
// SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------
// Description: Helpers for uv-based Python workflows.
// -----------------------------------------------------------------------------

/**
 * UV Extension - Redirects Python tooling to uv equivalents
 *
 * Blocks pip/pip3/poetry and python -m pip/venv/py_compile at bash spawn time
 * with helpful messages pointing to the uv equivalents.
 *
 * Intercepted commands:
 * - pip/pip3: Blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: Blocked with uv equivalents (uv init, uv add, uv sync, uv run)
 * - python/python3: python -m pip/venv/py_compile blocked, suggestions for uv equivalents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

function getBlockedCommandMessage(command: string): string | null {
    // Match commands at the start of a shell segment (start/newline/; /&& /|| /|)
    const pipCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip\s*(?:$|\s)/m;
    const pip3CommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip3\s*(?:$|\s)/m;
    const poetryCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?poetry\s*(?:$|\s)/m;

    // Match python invocations including explicit paths like .venv/bin/python
    // and .venv/bin/python3.12.
    const pythonPipPattern =
        /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*pip\b|\s-mpip\b)/m;
    const pythonVenvPattern =
        /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*venv\b|\s-mvenv\b)/m;
    const pythonPyCompilePattern =
        /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*py_compile\b|\s-mpy_compile\b)/m;

    if (pipCommandPattern.test(command)) {
        return [
            "Error: pip is disabled. Use uv instead:",
            "",
            "  To install a package for a script: uv run --with PACKAGE python script.py",
            "  To add a dependency to the project: uv add PACKAGE",
            "",
        ].join("\n");
    }

    if (pip3CommandPattern.test(command)) {
        return [
            "Error: pip3 is disabled. Use uv instead:",
            "",
            "  To install a package for a script: uv run --with PACKAGE python script.py",
            "  To add a dependency to the project: uv add PACKAGE",
            "",
        ].join("\n");
    }

    if (poetryCommandPattern.test(command)) {
        return [
            "Error: poetry is disabled. Use uv instead:",
            "",
            "  To initialize a project: uv init",
            "  To add a dependency: uv add PACKAGE",
            "  To sync dependencies: uv sync",
            "  To run commands: uv run COMMAND",
            "",
        ].join("\n");
    }

    if (pythonPipPattern.test(command)) {
        return [
            "Error: 'python -m pip' is disabled. Use uv instead:",
            "",
            "  To install a package for a script: uv run --with PACKAGE python script.py",
            "  To add a dependency to the project: uv add PACKAGE",
            "",
        ].join("\n");
    }

    if (pythonVenvPattern.test(command)) {
        return [
            "Error: 'python -m venv' is disabled. Use uv instead:",
            "",
            "  To create a virtual environment: uv venv",
            "",
        ].join("\n");
    }

    if (pythonPyCompilePattern.test(command)) {
        return [
            "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
            "",
            "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
            "",
        ].join("\n");
    }

    return null;
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, _ctx) => {
        if (!isToolCallEventType("bash", event)) return;

        const blocked = getBlockedCommandMessage(event.input.command);
        if (blocked) {
            return { block: true, reason: blocked };
        }
    });
}
