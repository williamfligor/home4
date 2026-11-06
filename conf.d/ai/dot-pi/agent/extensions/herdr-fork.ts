/**
 * herdr-fork: continue this conversation in a new terminal, next to this one.
 *
 * `/herdr-fork` copies the current session — same entry tree, same leaf, new
 * session id, `parentSession` pointing back here — and opens the copy in a
 * fresh terminal, leaving this one untouched:
 *
 * - inside Herdr (`HERDR_ENV=1`): a new tab in the calling workspace, with the
 *   forked Pi started as a recognized agent (`herdr agent start --kind pi`).
 * - inside Herdr Core (`HC_TERMINAL_ID`): a new `hc` terminal started
 *   `--bg --outlive-parent`, so it keeps running when this Pi exits.
 *
 * Arguments:
 *   --no-focus        create the tab without moving focus to it (Herdr only)
 *   --label <text>    tab label (Herdr only, default `fork <session>`)
 *   -- <args…>        passed to the forked Pi, e.g. `/herdr-fork -- --model x`
 *
 * Herdr Core has no tabs: its unit of layout is the terminal, and window
 * arrangement belongs to the app, not to `hc`.
 */
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

/** A host that can open a terminal for the forked session. */
type Host = { kind: "herdr"; bin: string; workspace?: string } | { kind: "herdr-core"; bin: string };

/** Where the forked session ended up. */
export type ForkTarget = { tabId?: string; paneId?: string; label?: string; terminal?: string };

const COMMAND = "herdr-fork";
const CLI_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// host detection
// ---------------------------------------------------------------------------

/** First executable among `names` on PATH, else the first existing absolute candidate. */
function findExecutable(
    names: readonly string[],
    fallbacks: readonly (string | undefined)[] = [],
): string | undefined {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const name of names) {
        for (const dir of dirs) {
            const candidate = path.join(dir, name);
            try {
                accessSync(candidate, fsConstants.X_OK);
                return candidate;
            } catch {
                // keep looking
            }
        }
    }
    for (const candidate of fallbacks) {
        if (!candidate) continue;
        try {
            accessSync(candidate, fsConstants.X_OK);
            return candidate;
        } catch {
            // keep looking
        }
    }
    return undefined;
}

/**
 * Which terminal host this Pi runs under.
 *
 * `HC_TERMINAL_ID` wins over `HERDR_ENV`: an `hc` terminal inherits whatever
 * environment the Herdr Core server was started with, so a stray `HERDR_ENV`
 * inside one points at a pane that may no longer exist.
 */
export function detectHost(env: NodeJS.ProcessEnv = process.env): Host | undefined {
    if (env.HC_TERMINAL_ID) {
        const bin = findExecutable(["hc"], [env.HC_BIN_PATH]);
        if (bin) return { kind: "herdr-core", bin };
    }
    if (env.HERDR_ENV === "1" && env.HERDR_SOCKET_PATH) {
        // HERDR_BIN_PATH is inherited from the pane's creation, so it can be
        // stale or already deleted; the running CLI on PATH is the better bet.
        const bin = findExecutable(["herdr"], [env.HERDR_BIN_PATH]);
        if (bin) return { kind: "herdr", bin, workspace: env.HERDR_WORKSPACE_ID };
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

export type ForkArgs = { focus: boolean; label?: string; extra: string[] };

/** Split on whitespace, honouring single and double quotes; `\` escapes outside quotes. */
export function tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let started = false;
    let quote: '"' | "'" | undefined;

    for (let i = 0; i < input.length; i++) {
        const char = input[i]!;
        if (quote) {
            if (char === quote) quote = undefined;
            else current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            started = true;
            continue;
        }
        if (char === "\\" && i + 1 < input.length) {
            current += input[++i];
            started = true;
            continue;
        }
        if (/\s/.test(char)) {
            if (started) tokens.push(current);
            current = "";
            started = false;
            continue;
        }
        current += char;
        started = true;
    }
    if (started) tokens.push(current);
    return tokens;
}

export function parseArgs(input: string): ForkArgs {
    const tokens = tokenize(input);
    const extra: string[] = [];
    let focus = true;
    let label: string | undefined;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token === "--") {
            extra.push(...tokens.slice(i + 1));
            break;
        }
        if (token === "--no-focus") {
            focus = false;
            continue;
        }
        if (token === "--label") {
            const value = tokens[++i];
            if (value === undefined) throw new Error("--label needs a value");
            label = value;
            continue;
        }
        if (token.startsWith("--label=")) {
            label = token.slice("--label=".length);
            continue;
        }
        // Anything else is a Pi flag for the fork (`--model`, `--thinking`, …).
        extra.push(token);
    }
    return { focus, label, extra };
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

type CliResult = { ok: boolean; json?: any; stdout: string; stderr: string };

/** Run a CLI and parse its JSON, without throwing on a non-zero exit. */
async function runCli(bin: string, args: string[]): Promise<CliResult> {
    try {
        const { stdout, stderr } = await execFileAsync(bin, args, {
            env: process.env,
            timeout: CLI_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
        });
        return { ok: true, json: parseJson(stdout), stdout, stderr };
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        const stdout = failure.stdout ?? "";
        const stderr = failure.stderr ?? failure.message ?? String(error);
        return { ok: false, json: parseJson(stdout) ?? parseJson(stderr), stdout, stderr };
    }
}

function parseJson(text: string | undefined): any {
    if (!text) return undefined;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
}

/** `fork-1a2b3c`: unique enough, and legal for both Herdr agent and `hc` names. */
export function forkName(): string {
    return `fork-${randomBytes(3).toString("hex")}`;
}

/** Short session id used in labels and notifications. */
function shortId(sessionId: string | undefined): string {
    return (sessionId ?? "").slice(0, 8) || "session";
}

// ---------------------------------------------------------------------------
// hosts
// ---------------------------------------------------------------------------

const AGENT_BUSY_RETRIES = 40;
const AGENT_BUSY_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Herdr: one tab per fork, in the calling workspace.
 *
 * `tab create` returns the new root pane at a fresh shell; `agent start` needs
 * that shell to have reached its prompt, and reports `agent_pane_busy` until it
 * has, so the first calls are retried rather than failing the command.
 */
async function forkInHerdr(
    host: Extract<Host, { kind: "herdr" }>,
    args: ForkArgs,
    opts: ForkContext,
): Promise<ForkTarget> {
    const label = args.label ?? `fork ${shortId(opts.sessionId)}`;
    const tabArgs = [
        "tab",
        "create",
        "--cwd",
        opts.cwd,
        "--label",
        label,
        args.focus ? "--focus" : "--no-focus",
    ];
    if (host.workspace) tabArgs.push("--workspace", host.workspace);

    const created = await runCli(host.bin, tabArgs);
    if (!created.ok || created.json?.error) {
        throw new Error(describeFailure("herdr tab create", created));
    }
    const tabId = created.json?.result?.tab?.tab_id as string | undefined;
    const paneId = created.json?.result?.root_pane?.pane_id as string | undefined;
    if (!paneId) throw new Error(`herdr tab create returned no pane: ${created.stdout.trim()}`);

    const name = forkName();
    const startArgs = [
        "agent",
        "start",
        name,
        "--kind",
        "pi",
        "--pane",
        paneId,
        "--timeout",
        "60000",
        "--",
        ...opts.piArgs,
    ];

    let last: CliResult | undefined;
    for (let attempt = 0; attempt < AGENT_BUSY_RETRIES; attempt++) {
        last = await runCli(host.bin, startArgs);
        if (last.ok && !last.json?.error) return { tabId, paneId, label };
        if (last.json?.error?.code !== "agent_pane_busy") break;
        await sleep(AGENT_BUSY_DELAY_MS);
    }
    throw new Error(
        describeFailure("herdr agent start", last ?? { ok: false, stdout: "", stderr: "" }, `tab ${label}`),
    );
}

/** `hc` rejects a name that is taken or malformed; only those are worth another try. */
function isNameError(result: CliResult): boolean {
    const error = result.json?.error;
    const kind = String(error?.kind ?? error?.code ?? "");
    return kind.includes("name") || String(error?.message ?? "").includes("name");
}

/** Herdr Core: one `hc` terminal per fork, outliving this one. */
async function forkInHerdrCore(
    host: Extract<Host, { kind: "herdr-core" }>,
    opts: ForkContext,
): Promise<ForkTarget> {
    let last: CliResult | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
        const runArgs = [
            "run",
            "--json",
            "--bg",
            "--no-notify",
            "--outlive-parent",
            "--name",
            forkName(),
            "--cwd",
            opts.cwd,
            ...(opts.piBin ? [opts.piBin] : ["pi"]),
            ...opts.piArgs,
        ];
        last = await runCli(host.bin, runArgs);
        if (last.ok && !last.json?.error) return { terminal: last.json?.address as string | undefined };
        if (!isNameError(last)) break;
    }
    throw new Error(describeFailure("hc run", last ?? { ok: false, stdout: "", stderr: "" }));
}

type ForkContext = { cwd: string; sessionId?: string; piArgs: string[]; piBin?: string };

function describeFailure(what: string, result: CliResult, where?: string): string {
    const detail =
        result.json?.error?.message ??
        result.json?.error?.hint ??
        (result.stderr.trim() || result.stdout.trim());
    const suffix = where ? ` (${where} left open)` : "";
    return `${what} failed${suffix}: ${detail || "no output"}`;
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
    pi.registerCommand(COMMAND, {
        description: "Fork this session into a new Herdr tab (or Herdr Core terminal)",
        handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
            const args = parseArgs(rawArgs);

            const host = detectHost();
            if (!host) {
                ctx.ui.notify(
                    `${COMMAND}: not inside Herdr (no HERDR_ENV) or Herdr Core (no HC_TERMINAL_ID)`,
                    "error",
                );
                return;
            }

            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) {
                ctx.ui.notify(
                    `${COMMAND}: this session is in memory (--no-session); there is nothing to fork`,
                    "error",
                );
                return;
            }

            if (!ctx.isIdle()) {
                ctx.ui.notify(`${COMMAND}: waiting for the current turn to finish…`, "info");
                await ctx.waitForIdle();
            }

            const fork: ForkContext = {
                cwd: ctx.cwd,
                sessionId: ctx.sessionManager.getSessionId(),
                piArgs: ["--fork", sessionFile, ...args.extra],
                piBin: process.env.PI_BIN,
            };

            try {
                const target =
                    host.kind === "herdr"
                        ? await forkInHerdr(host, args, fork)
                        : await forkInHerdrCore(host, fork);
                const where = target.tabId
                    ? `tab "${target.label}" (${target.tabId})`
                    : `terminal ${target.terminal ?? "(unknown address)"}`;
                ctx.ui.notify(`Forked ${shortId(fork.sessionId)} into ${where}`, "info");
            } catch (error) {
                ctx.ui.notify(
                    `${COMMAND}: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            }
        },
    });
}
