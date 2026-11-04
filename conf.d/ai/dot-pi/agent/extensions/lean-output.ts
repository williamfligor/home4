/**
 * lean-output — condensed tool rows and no hidden-thinking label.
 *
 *   ● Explored 1 file (SessionServiceDeviceTest.kt) Took 0.1s
 *   ● Ran (mise exec -- adb devices) Took 4.2s
 *   ● Ran (bash scripts/check.sh) failed Took 1m 03s (ctrl+o to expand)
 *   ● Explored 2 files (A.kt, B.kt) Took 0.3s
 *   ... 39 more actions (21 reads, 9 edits, 9 commands: 2 failed) ...
 *
 * Two parts, one switch:
 *
 *   rows      one compact row per call for every tool via
 *             pi.registerToolRenderer, plus run merging + middle-folding via a
 *             guarded Container.render wrapper (private API — feature-detected,
 *             idempotent, falls back to stock render). Expanded view shows the
 *             full output as plain dim text.
 *   thinking  with `hideThinkingBlock` on, pi renders a one-line label in place
 *             of the thinking content and offers no setting for "no label", so
 *             the label is set to a NUL sentinel via `ui.setHiddenThinkingLabel`
 *             and the child carrying it is removed in a patched
 *             AssistantMessageComponent.updateContent. Removing it leaves two
 *             Spacers behind; adjacent ones are collapsed.
 *
 * Timing: every row carries its wall clock — `Running… 3.2s` while it runs
 * (redrawn once a second off the row's `invalidate`), `Took 3.4s` once settled
 * (pi's recorded `durationMs`, falling back to the renderer clock).
 *
 * Spacing: rows inside a run are dense, but the run stays one blank line below
 * the prose above it. pi core prefixes every self-rendered tool row with an
 * empty line; the per-row trim drops that (it is what makes rows dense) and
 * the container wrapper puts one separator back ahead of each run.
 *
 * Images: a tool result that carries an image (`read` on a PNG) renders it as
 * extra children of the row. On Kitty terminals that block is the image
 * sequence followed by N-1 *blank* lines — those blanks are the reservation
 * the TUI counts to know how many rows the image covers, so the spacing trim
 * and the run folding both step aside for rows that hold one.
 *
 * Coverage: every tool. pi's own, third-party ones (ffgrep/fffind/
 * fff-multi-grep, codemode, MCP, subagent, …) and anything registered later all
 * get a condensed row. A name with no mapping renders `● <name> (detail)`; names
 * ending in grep/search/find/read/edit/shell borrow the matching verb.
 * PI_LEAN_KEEP is the escape hatch for a tool that must keep its own renderer.
 *
 * Sole owner: this is the only extension that patches tool-row rendering
 * (`Container.render`, `ToolExecutionComponent.render`). A second extension
 * patching the same stack is how the blank-line reservation around inline
 * images got eaten once already — use `PI_LEAN_KEEP` plus your own
 * `registerToolRenderer` instead of re-patching.
 *
 * Toggling: `/lean [on|off|rows|thinking|status]` flips the running session with
 * no reload. A row bakes its renderer definition in at construction
 * (`ToolExecutionComponent` stores `toolDefinition` and picks its shell
 * container from it), so a flag check alone cannot change a row that already
 * exists: `restock` swaps the definition back to the chain's base (or forward to
 * ours), reattaches the matching shell container and calls the row's own
 * `invalidate`, which re-runs `updateDisplay`. The thinking label comes back
 * through `ui.setHiddenThinkingLabel(undefined)`, which re-runs every assistant
 * component's `updateContent` for us. Both patches check their switch per call,
 * so prose/tool gutters follow immediately. `--no-lean` and `PI_LEAN=off` start a
 * process with the whole extension off.
 *
 * Config:
 *   PI_LEAN=off           → start with the whole extension off (stock pi)
 *   PI_LEAN_ROWS=off      → condensed rows only (keep the thinking-label part)
 *   PI_LEAN_THINKING=off  → thinking label only (keep the rows)
 *   PI_LEAN_KEEP          → comma list left to its own renderer, `prefix*` ok
 *   PI_LEAN_GROUP=off     → per-tool rows only, no merging/folding
 *   PI_LEAN_THRESHOLD     → fold runs longer than N (default 5)
 *   PI_LEAN_TIME=off      → hide the running/took duration
 */

import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, keyText, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as tuiNs from "@earendil-works/pi-tui";

const tw = (tuiNs as any).truncateToWidth as ((s: string, w: number, e?: string) => string) | undefined;
const vw = (tuiNs as any).visibleWidth as ((s: string) => number) | undefined;

const MAX_CMD = 72;
const MAX_DETAIL = 80;
const ANSI = /\x1b\[[0-9;]*m/g;

type Theme = { fg: (c: string, s: string) => string; bold: (s: string) => string };

// ── session state ───────────────────────────────────────────────────────────
// Kept on globalThis instead of module scope: ctx.reload() (a real session
// reload, not our toggle) re-imports this file — while the Container /
// ToolExecutionComponent / AssistantMessageComponent prototypes patched by the
// *previous* instance stay patched. Everything instances must agree on (the
// switches, the theme the grouping patch paints with, the shared row clock, the
// live row registry) therefore lives here.

const STATE_KEY = Symbol.for("lean-output.state");

const PLAIN: Theme = { fg: (_c, s) => s, bold: (s) => s };

interface LeanState {
    /** Master switch: seeded from env + --no-lean, flipped by /lean. */
    on: boolean;
    /** Rows part: off leaves pi's stock tool rows. */
    rows: boolean;
    /** Thinking part: off brings pi's hidden-thinking label back. */
    thinking: boolean;
    /** Captured at session start; the patches get no ctx of their own. */
    theme: Theme;
    /** Rows redrawing their `Running… 3.2s` clock. */
    ticking: Set<() => void>;
    ticker?: ReturnType<typeof setInterval>;
    /** Every tool row this session, so /lean can restock them in place. */
    components: Set<any>;
    /** Base (stock) definition per tool name, resolved through us. */
    bases: Map<string, any>;
    /** Label currently pushed to the UI; undefined = pi's own default. */
    labelApplied?: string;
}

const isOff = (v: string | undefined) => /^(off|0|false|no)$/i.test((v ?? "").trim());

function state(): LeanState {
    const g = globalThis as Record<PropertyKey, unknown>;
    if (!g[STATE_KEY]) {
        g[STATE_KEY] = {
            on: !isOff(process.env.PI_LEAN),
            rows: !isOff(process.env.PI_LEAN_ROWS),
            thinking: !isOff(process.env.PI_LEAN_THINKING),
            theme: PLAIN,
            ticking: new Set(),
            components: new Set(),
            bases: new Map(),
            labelApplied: undefined,
        } satisfies LeanState;
    }
    return g[STATE_KEY] as LeanState;
}

/** Rows are condensed (master switch and rows part both on). */
const enabled = () => state().on && state().rows;

/** The hidden-thinking label is suppressed (master switch and thinking part on). */
const thinkingOn = () => state().on && state().thinking;

/**
 * Tools left to their own renderer (`PI_LEAN_KEEP`): an exact name or a
 * `prefix*` pattern. Read once — it is a startup decision, like the mode.
 */
const KEEP: string[] = (() => {
    const raw = (process.env.PI_LEAN_KEEP ?? "").trim();
    return raw
        ? raw
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
        : [];
})();

function kept(toolName: string): boolean {
    const name = toolName.toLowerCase();
    return KEEP.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** Does lean-output own this tool's row right now? */
const owns = (toolName: string) => enabled() && !kept(toolName);

function oneLine(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return `${s.slice(0, n - 1)}…`;
}

function basename(p: string): string {
    const clean = p.replace(/\/+$/, "");
    const i = clean.lastIndexOf("/");
    return i >= 0 ? clean.slice(i + 1) : clean;
}

function resultText(result: any): string {
    return ((result?.content ?? []) as any[])
        .filter((c) => c && c.type === "text")
        .map((c) => String(c.text ?? ""))
        .join("\n");
}

function expandHint(theme: Theme): string {
    try {
        const key = (keyText as (id: string) => string | undefined)("app.tools.expand");
        if (key) return theme.fg("dim", ` (${key} to expand)`);
    } catch {
        /* host without keybindings — fall through */
    }
    return theme.fg("dim", " (ctrl+o to expand)");
}

// ── per-row clock ───────────────────────────────────────────────────────────
// pi keeps `startToolTimer`/`toolTimerText`/`formatToolDuration` internal to
// core/tools/render-utils, so the handful of lines are mirrored here: the row's
// `state` carries the start time, `invalidate()` repaints it every second while
// partial, and the final render prefers pi's recorded `durationMs`.

type RowClock = { startedAt?: number; endedAt?: number; tick?: () => void };

const showTime = () => !/^(0|off|false|no)$/i.test((process.env.PI_LEAN_TIME ?? "").trim());

/** A row that never settles must not repaint the transcript forever. */
const MAX_TICK_AGE = 6 * 60 * 60 * 1000;

/**
 * One shared 1s ticker for every running row: N parallel tool calls still cost
 * a single `requestRender` per second, not N of them. Rows drop out as they
 * settle, and the interval dies with the last one.
 */
function ensureTicker(): void {
    const s = state();
    if (s.ticker) return;
    s.ticker = setInterval(() => {
        const live = state();
        for (const fn of live.ticking) {
            try {
                fn();
            } catch {
                live.ticking.delete(fn);
            }
        }
        if (live.ticking.size === 0 && live.ticker) {
            clearInterval(live.ticker);
            live.ticker = undefined;
        }
    }, 1000);
}

function stopClock(row: RowClock | undefined): void {
    if (!row?.tick) return;
    state().ticking.delete(row.tick);
    row.tick = undefined;
}

function stopAllClocks(): void {
    const s = state();
    s.ticking.clear();
    if (s.ticker) clearInterval(s.ticker);
    s.ticker = undefined;
}

/** Start the clock on execution, tick it while partial, stop it on settle. */
function driveClock(ctx: any): void {
    const row: RowClock | undefined = ctx?.state;
    if (!row) return;
    if (!ctx.executionStarted) return;
    if (row.startedAt === undefined) {
        row.startedAt = Date.now();
        row.endedAt = undefined;
    }
    if (!ctx.isPartial) {
        row.endedAt ??= Date.now();
        stopClock(row);
        return;
    }
    if (!row.tick) {
        row.tick = () => {
            if (Date.now() - (row.startedAt ?? 0) > MAX_TICK_AGE) {
                stopClock(row);
                return;
            }
            ctx.invalidate();
        };
    }
    state().ticking.add(row.tick);
    ensureTicker();
}

function formatDuration(ms: number): string {
    const seconds = Math.max(0, ms) / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${remainder}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** `3.2s` while the row is still running, from the renderer clock. */
function elapsedText(ctx: any, theme: Theme): string | undefined {
    if (!showTime()) return undefined;
    const row: RowClock | undefined = ctx?.state;
    if (row?.startedAt === undefined) return undefined;
    return theme.fg("dim", formatDuration((row.endedAt ?? Date.now()) - row.startedAt));
}

/** `Took 3.4s` once settled: pi's recorded duration wins, the clock is the fallback. */
function tookText(ctx: any, theme: Theme): string | undefined {
    if (!showTime()) return undefined;
    let ms: number | undefined = typeof ctx?.durationMs === "number" ? ctx.durationMs : undefined;
    if (ms === undefined) {
        const row: RowClock | undefined = ctx?.state;
        if (row?.startedAt === undefined) return undefined;
        ms = (row.endedAt ?? Date.now()) - row.startedAt;
    }
    return theme.fg("dim", `Took ${formatDuration(ms)}`);
}

/** Same, for rows the grouping pass reads straight off the tool record. */
function tookFromResult(tool: any, theme: Theme): string | undefined {
    if (!showTime()) return undefined;
    const ms = tool?.result?.durationMs;
    return typeof ms === "number" ? theme.fg("dim", `Took ${formatDuration(ms)}`) : undefined;
}

function dot(theme: Theme, kind: "ok" | "err" | "run"): string {
    if (kind === "err") return theme.fg("error", "● ");
    if (kind === "run") return theme.fg("accent", "● ");
    return theme.fg("success", "● ");
}

// ── per-tool verb lines (collapsed) ─────────────────────────────────────────

/**
 * `verb`/`noun` drive the row text. `single` means a lone call reads as the verb
 * alone (`● Ran (git diff …)`) instead of `● Ran 1 command (…)`; `generic` means
 * the label is the tool's own name, so the expanded title is not `name name`.
 */
type Verb = { verb: string; noun: string; single?: boolean; generic?: boolean };

const KNOWN: Record<string, Verb> = {
    read: { verb: "Explored", noun: "file" },
    edit: { verb: "Edited", noun: "file" },
    write: { verb: "Edited", noun: "file" },
    apply_patch: { verb: "Edited", noun: "file" },
    bash: { verb: "Ran", noun: "command", single: true },
    codemode: { verb: "Ran", noun: "tool", single: true },
    grep: { verb: "Searched", noun: "match" },
    find: { verb: "Found", noun: "file" },
    ls: { verb: "Listed", noun: "entry" },
    recall: { verb: "Recalled", noun: "entry" },
};

/** `fff-multi-grep` → `fff-multi-grep`; `mcp__fs__read` → `read`. */
function toolLabel(toolName: string): string {
    const tail =
        toolName
            .split(/__|::|[:/]/)
            .filter(Boolean)
            .pop() ?? toolName;
    return tail || toolName;
}

/**
 * Every tool gets a verb: the table above, then suffix rules so tools we have
 * never seen still read sensibly (`ffgrep`, `web_search`, `fff-multi-grep`,
 * `<x>_read`), then the tool's own name for everything else.
 */
function verbFor(toolName: string): Verb {
    const known = KNOWN[toolName];
    if (known) return known;
    const name = toolName.toLowerCase();
    if (/(grep|search)$/.test(name)) return { verb: "Searched", noun: "match" };
    if (/(find|glob|locate)$/.test(name)) return { verb: "Found", noun: "file" };
    if (/(read|view|cat)$/.test(name)) return { verb: "Explored", noun: "file" };
    if (/(edit|write|patch|apply)$/.test(name)) return { verb: "Edited", noun: "file" };
    if (/(bash|shell|exec|terminal)$/.test(name)) return { verb: "Ran", noun: "command", single: true };
    return { verb: toolLabel(toolName), noun: "call", single: true, generic: true };
}

function isSearchish(toolName: string): boolean {
    return /(grep|search|find|glob|locate)$/i.test(toolName);
}

function detailFor(toolName: string, args: any): string {
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    switch (toolName) {
        case "read":
        case "edit":
        case "write":
            return basename(s(args?.path) || s((args as any)?.file_path) || ".");
        case "apply_patch": {
            const changes = Array.isArray((args as any)?.changes) ? (args as any).changes : [];
            const first = changes.find((c: any) => typeof c?.path === "string")?.path;
            if (!first) return "";
            return changes.length > 1 ? `${basename(first)}, +${changes.length - 1}` : basename(first);
        }
        case "bash":
            return oneLine(s(args?.command));
        case "grep": {
            const pattern = s(args?.pattern);
            const where = s(args?.path) || s(args?.glob);
            return where ? `${pattern} in ${basename(where)}` : pattern;
        }
        case "find": {
            const pattern = s(args?.pattern);
            const where = s(args?.path);
            return [pattern, where ? basename(where) : ""].filter(Boolean).join(", ");
        }
        case "ls":
            return basename(s(args?.path) || ".");
        case "codemode": {
            const code = oneLine(s(args?.code));
            return code.split("\n")[0] ?? "";
        }
        case "recall":
            return oneLine(s(args?.query)).slice(0, 60) || "browse";
        default: {
            const first = Object.values(args ?? {}).find((v) => typeof v === "string" && v) as
                string | undefined;
            if (!first) return "";
            const label = oneLine(first);
            // `ffgrep --pattern /x/ --path src` should say where, like `grep` does.
            const where = typeof (args as any)?.path === "string" ? basename((args as any).path) : "";
            return where && isSearchish(toolName) ? `${label} in ${where}` : label;
        }
    }
}

/**
 * `width` is only passed by the folded-run path, whose rows are pushed into the
 * container raw (no `Text`, so no wrapping). Those rows give up detail before
 * they give up the `(ctrl+o to expand)` affordance — the detail is already
 * elided anyway, the hint is what tells you the output is still there.
 */
function collapsedLine(
    toolName: string,
    args: any,
    result: any,
    isError: boolean,
    theme: Theme,
    dur?: string,
    width?: number,
): string {
    const v = verbFor(toolName);
    const raw = detailFor(toolName, args);
    const maxDetail = v.single ? MAX_CMD : MAX_DETAIL;

    let head: string;
    if (v.single) {
        // screenshot #2: single shell run omits the count — `Ran (cmd)`
        head = theme.bold(v.verb);
    } else {
        head = theme.bold(`${v.verb} 1 ${v.noun}`);
    }
    const compose = (detail: string) => {
        let line = `${dot(theme, isError ? "err" : "ok")}${head}`;
        if (detail) line += ` ${theme.fg("dim", `(${detail})`)}`;
        if (isError) line += ` ${theme.fg("error", "failed")}`;
        if (dur) line += ` ${dur}`;
        return line + expandHint(theme);
    };

    const detail = truncate(raw, maxDetail);
    let line = compose(detail);
    if (width !== undefined) {
        const over = wlen(line) - width;
        if (over > 0 && detail) {
            const budget = wlen(detail) - over;
            line = compose(budget > 1 ? truncate(raw, Math.min(maxDetail, budget)) : "");
        }
        line = fit(line, width);
    }
    return line;
}

function runningLine(toolName: string, args: any, theme: Theme, clock?: string): string {
    const v = verbFor(toolName);
    const detail = truncate(detailFor(toolName, args), MAX_CMD);
    let head = v.single ? v.verb : `${v.verb} 1 ${v.noun}`;
    let line = `${dot(theme, "run")}${theme.bold(head)}`;
    if (detail) line += ` ${theme.fg("muted", `(${detail})`)}`;
    line += ` ${theme.fg("dim", "Running…")}`;
    if (clock) line += ` ${clock}`;
    return line;
}

function expandedBody(
    toolName: string,
    args: any,
    result: any,
    isError: boolean,
    theme: Theme,
    dur?: string,
): string {
    const v = verbFor(toolName);
    const title = v.generic ? toolName : `${v.verb} ${toolName}`;
    const header =
        theme.bold(title) +
        (detailFor(toolName, args)
            ? theme.fg("dim", ` (${truncate(detailFor(toolName, args), MAX_CMD)})`)
            : "") +
        (dur ? ` ${dur}` : "");
    const text = resultText(result).replace(/\r/g, "").trimEnd();
    if (!text) return `${header}\n${isError ? theme.fg("error", "failed") : theme.fg("success", "done")}`;
    const lines = text.split("\n").slice(0, 80);
    const body = lines.map((l) => theme.fg("muted", l)).join("\n");
    const rest =
        text.split("\n").length > 80
            ? `\n${theme.fg("dim", `... ${text.split("\n").length - 80} more lines`)}`
            : "";
    return `${header}\n${body}${rest}`;
}

function verbRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
    // Passing the next resolver's renderers through keeps `/lean off` working
    // for rows that were created while it was on: they were built into the
    // "self" shell, so there is no box to fall back to, but the content can
    // still be drawn by the renderer that would have owned it. `restock` is what
    // puts such a row back into the stock shell.
    const fallback = (kind: "renderCall" | "renderResult", args: any[]) => {
        const fn = (base as any)?.[kind];
        if (typeof fn === "function") {
            try {
                return fn.apply(base, args);
            } catch {
                /* fall through to an empty row */
            }
        }
        return new Text("", 0, 0);
    };

    return {
        renderShell: "self",
        renderCall: (args, theme, ctx) => {
            if (!owns(toolName)) return fallback("renderCall", [args, theme, ctx]);
            // Owns the clock for this row: starts it, ticks it, stops it on settle.
            driveClock(ctx as any);
            if (ctx.isPartial) {
                return new Text(
                    runningLine(toolName, args, theme as Theme, elapsedText(ctx as any, theme as Theme)),
                    0,
                    0,
                );
            }
            return new Text("", 0, 0);
        },
        renderResult: (result, options, theme, ctx) => {
            if (!owns(toolName)) return fallback("renderResult", [result, options, theme, ctx]);
            if (options.isPartial) return new Text("", 0, 0);
            // Belt and braces: renderCall normally stops the tick on the final pass.
            stopClock((ctx as any)?.state);
            if (options.expanded) {
                return new Text(
                    expandedBody(
                        toolName,
                        (ctx as any).args,
                        result,
                        (ctx as any).isError,
                        theme as Theme,
                        tookText(ctx as any, theme as Theme),
                    ),
                    0,
                    0,
                );
            }
            const line = collapsedLine(
                toolName,
                (ctx as any).args,
                result,
                (ctx as any).isError,
                theme as Theme,
                tookText(ctx as any, theme as Theme),
            );
            if (!line) return new Text("", 0, 0);
            return new Text(line, 0, 0);
        },
    };
}

// ── wiring + v2 grouping (merge + middle-fold) ────────────────────────────

// Separator for a run of condensed rows. The per-row spacing trim removes the
// empty line pi core prepends to every self-rendered tool row, which also
// removes the gap between prose and the first row; the container wrapper adds
// this one back as a real layout entry so click hit-testing stays aligned.
const RUN_GAP = new Spacer(1);

const groupOff = () => /^(0|off|false|no)$/i.test((process.env.PI_LEAN_GROUP ?? "").trim());
const foldThreshold = () => {
    const n = parseInt(process.env.PI_LEAN_THRESHOLD ?? "5", 10);
    return Number.isFinite(n) && n >= 3 ? n : 5;
};
const KEEP_HEAD = 2;
const KEEP_TAIL = 2;

function wlen(s: string): number {
    try {
        if (vw) return vw(s);
    } catch {
        /* fall through */
    }
    return s.replace(ANSI, "").length;
}

/** Kitty (`ESC _ G`) and iTerm2 (`OSC 1337;File=`) inline-image sequences. */
const IMAGE_SEQ = /\x1b_G|\x1b\]1337;File=/;

/**
 * Does this row carry an inline image? Such a row's blank lines are not
 * padding — the TUI counts them as the image's reserved rows, so trimming or
 * merging them draws the next lines on top of the image.
 */
function hasImage(lines: string[]): boolean {
    return lines.some((l) => IMAGE_SEQ.test(l));
}

function fit(s: string, width: number): string {
    if (width <= 0) return s;
    try {
        if (wlen(s) <= width) return s;
    } catch {
        /* fall through */
    }
    try {
        if (tw) return tw(s, width);
    } catch {
        /* fall through */
    }
    return `${s.replace(ANSI, "").slice(0, Math.max(0, width - 1))}…`;
}

function isToolChild(c: any): boolean {
    try {
        return typeof c?.toolCallId === "string" && typeof c.toolName === "string" && owns(c.toolName);
    } catch {
        return false;
    }
}

function mergeKey(toolName: string): string {
    const v = verbFor(toolName);
    return v ? `${v.verb} ${v.noun}` : toolName;
}

function adjacentGroups(tools: any[]): any[][] {
    const out: any[][] = [];
    for (const t of tools) {
        const k = mergeKey((t as any).toolName);
        const last = out[out.length - 1];
        if (last && mergeKey((last[0] as any).toolName) === k) last.push(t);
        else out.push([t]);
    }
    return out;
}

function mergedLine(group: any[], theme: Theme, width: number): string {
    const t0 = group[0] as any;
    const v = verbFor(t0.toolName);
    if (group.length === 1) {
        // These rows bypass Text (they are pushed into the container raw, no
        // wrapping and no padding), so they must be measured and cut here.
        return collapsedLine(
            t0.toolName,
            t0.args,
            t0.result,
            !!t0.result?.isError,
            theme,
            tookFromResult(t0, theme),
            width,
        );
    }
    const N = group.length;
    const failed = group.filter((t) => (t as any).result?.isError).length;
    const details = group.map((t) => detailFor((t as any).toolName, (t as any).args));
    const nounP = v.noun === "entry" ? "entries" : v.noun === "match" ? "matches" : `${v.noun}s`;
    const head = theme.bold(`${v.verb} ${N} ${nounP}`);
    let inner: string;
    if (v.verb === "Ran") {
        inner = `+${N - 1} · ${truncate(details[N - 1] || "", 48)}`;
    } else {
        const joined = details.join(", ");
        inner = joined.length > 64 ? `${details[0]}, +${N - 1} more` : joined;
    }
    let line = `${dot(theme, failed ? "err" : "ok")}${head}`;
    if (inner) line += ` ${theme.fg("dim", `(${inner})`)}`;
    if (failed) line += ` ${theme.fg("error", failed === 1 ? "failed" : `${failed} failed`)}`;
    // A merged row reports the run's total, only when every call recorded one.
    const timed = group.map((t) => (t as any)?.result?.durationMs);
    if (showTime() && timed.every((ms) => typeof ms === "number")) {
        line += ` ${theme.fg("dim", `Took ${formatDuration(timed.reduce((a, b) => a + (b as number), 0))}`)}`;
    }
    line += expandHint(theme);
    return fit(line, width);
}

function foldSummary(hidden: any[], theme: Theme): string {
    const N = hidden.length;
    let reads = 0;
    let edits = 0;
    let cmds = 0;
    let others = 0;
    let failed = 0;
    for (const t of hidden) {
        const n = (t as any).toolName;
        const v = verbFor(n);
        if (n === "edit" || n === "write" || n === "apply_patch") edits++;
        else if (n === "bash" || n === "codemode" || /(bash|shell|exec|terminal)$/i.test(n)) cmds++;
        // A generic verb is a tool we have no reading verb for (`subagent`,
        // `web_search`, an MCP tool): calling those "reads" would be a lie.
        else if (v.generic) others++;
        else reads++;
        if ((t as any).result?.isError) failed++;
    }
    const parts: string[] = [];
    if (reads) parts.push(`${reads} read${reads === 1 ? "" : "s"}`);
    if (edits) parts.push(`${edits} edit${edits === 1 ? "" : "s"}`);
    if (cmds) parts.push(`${cmds} command${cmds === 1 ? "" : "s"}`);
    if (others) parts.push(`${others} other${others === 1 ? "" : "s"}`);
    let s = parts.join(", ");
    if (failed) s += `: ${failed} failed`;
    return theme.fg("dim", `... ${N} more action${N === 1 ? "" : "s"} (${s}) ...`);
}

function clickComponent(owners: (any[] | undefined)[]): any {
    return {
        render: () => [] as string[],
        handleMouse: (event: any) => {
            try {
                if (event?.type !== "click" || event?.button !== "left") return undefined;
                const tools = owners[event.y];
                if (!Array.isArray(tools) || tools.length === 0) return undefined;
                const live = tools.filter((t) => t && typeof t.setExpanded === "function" && t.result);
                if (live.length === 0) return undefined;
                const allOpen = live.every((t) => t.expanded);
                for (const t of live) t.setExpanded(!allOpen);
                return { handled: true };
            } catch {
                return undefined;
            }
        },
    };
}

function renderGrouped(container: any, width: number, base: (w: number) => string[]): string[] {
    const kids: any[] = container.children;
    const theme = state().theme;
    const lines: string[] = [];
    const layout: { component: any; height: number }[] = [];
    const push = (comp: any, rendered: string[]) => {
        layout.push({ component: comp, height: rendered.length });
        for (const l of rendered) lines.push(l);
    };
    const safeRender = (c: any): string[] => {
        try {
            const r = c.render(width);
            return Array.isArray(r) ? r : [];
        } catch {
            return [];
        }
    };
    // One render per child per pass: the merge guard has to look at a row's
    // lines (for images) before pushRows draws it.
    const renders = new Map<any, string[]>();
    const linesOf = (c: any): string[] => {
        let lines = renders.get(c);
        if (!lines) {
            lines = safeRender(c);
            renders.set(c, lines);
        }
        return lines;
    };
    const pass = (c: any) => push(c, linesOf(c));
    // One blank line separates the tool block from the prose above it. pi emits
    // an AssistantMessageComponent per assistant turn; the ones carrying only a
    // tool call (and hidden thinking) render zero lines and sit *between* tool
    // rows. Those must not restart the block, or every row would get a gap.
    // `afterTool` therefore tracks the last visible line, not merely the last
    // child: invisible children leave it alone.
    let afterTool = false;
    const gapBefore = (firstLine: string | undefined) => {
        if (afterTool) return;
        const last = lines[lines.length - 1];
        if (last === undefined || isBlankLine(last)) return;
        if (firstLine !== undefined && isBlankLine(firstLine)) return;
        push(RUN_GAP, [""]);
    };
    // Rows kept as-is (single rows, expanded rows, unsettled/partial rows):
    // dense among themselves, one separator ahead of the first.
    const pushRows = (run: any[]) => {
        if (run.length === 0) return;
        const firstLines = linesOf(run[0]);
        gapBefore(firstLines[0]);
        push(run[0], firstLines);
        for (let k = 1; k < run.length; k++) pass(run[k]);
    };
    let i = 0;
    while (i < kids.length) {
        if (!isToolChild(kids[i])) {
            const before = lines.length;
            pass(kids[i]);
            if (lines.length > before) afterTool = false;
            i++;
            continue;
        }
        let j = i;
        while (j < kids.length && isToolChild(kids[j])) j++;
        const run = kids.slice(i, j);
        const settled = (t: any) => t && t.result && !t.isPartial;
        // A row holding an image (or an expanded one) is drawn as-is: merging
        // would replace the image block with a one-line summary.
        if (
            run.length < 2 ||
            run.some((t) => (t as any).expanded || hasImage(linesOf(t))) ||
            !run.every(settled)
        ) {
            pushRows(run);
            i = j;
            afterTool = true;
            continue;
        }
        if (run.length > foldThreshold()) {
            const head = run.slice(0, KEEP_HEAD);
            const hidden = run.slice(KEEP_HEAD, run.length - KEEP_TAIL);
            const tail = run.slice(run.length - KEEP_TAIL);
            const glines: string[] = [];
            const owners: (any[] | undefined)[] = [];
            for (const g of adjacentGroups(head)) {
                glines.push(mergedLine(g, theme, width));
                owners.push(g);
            }
            glines.push(fit(foldSummary(hidden, theme), width));
            owners.push(undefined);
            for (const g of adjacentGroups(tail)) {
                glines.push(mergedLine(g, theme, width));
                owners.push(g);
            }
            gapBefore(glines[0]);
            push(clickComponent(owners), glines);
        } else {
            const groups = adjacentGroups(run);
            if (groups.every((g) => g.length === 1)) {
                pushRows(run);
            } else {
                const glines: string[] = [];
                const owners: (any[] | undefined)[] = [];
                for (const g of groups) {
                    glines.push(mergedLine(g, theme, width));
                    owners.push(g);
                }
                gapBefore(glines[0]);
                push(clickComponent(owners), glines);
            }
        }
        i = j;
        afterTool = true;
    }
    try {
        (container as any).mouseLayout = { width, children: layout };
    } catch {
        /* hit-testing stays stock */
    }
    return lines;
}

const CONTAINER_KEY = Symbol.for("lean-output.container-render");

function isBlankLine(line: string): boolean {
    return line.replace(ANSI, "").trim().length === 0;
}

// Pi core pads every tool row with blank lines (a Spacer plus a leading ""
// for renderShell: "self" rows). Lean rows are dense — one row per line — so
// strip the padding for collapsed styled rows. The leading blank is pi's only
// separator from the prose above, so renderGrouped re-adds one before each run
// (see RUN_GAP). Expanded rows keep stock padding.
function installSpacingTrim(): void {
    try {
        const proto: any = (ToolExecutionComponent as any)?.prototype;
        if (!proto || typeof proto.render !== "function") return;
        if ((proto.render as any).__leanOutputSpacing) return;
        const base: (w: number) => string[] = proto.render;
        const patched = function (this: any, width: number): string[] {
            // Every row passes through here, on or off: /lean needs the list to
            // restock rows that were built while the other state was active.
            try {
                state().components.add(this);
            } catch {
                /* ignore */
            }
            let lines: string[];
            try {
                lines = base.call(this, width);
            } catch {
                return [];
            }
            try {
                if (!enabled()) return lines;
                if (this?.expanded) return lines;
                if (typeof this?.toolName !== "string" || !owns(this.toolName)) return lines;
                if (!Array.isArray(lines) || lines.length === 0) return lines;
                // Kitty reserves an image's rows with blank lines *after* the
                // sequence, so trimming them draws the transcript over the
                // image. Leave image rows exactly as pi rendered them.
                if (hasImage(lines)) return lines;
                let start = 0;
                let end = lines.length;
                while (start < end && isBlankLine(lines[start]!)) start++;
                while (end > start && isBlankLine(lines[end - 1]!)) end--;
                if (start === 0 && end === lines.length) return lines;
                if (typeof this.selfRenderHeight === "number") {
                    this.selfRenderHeight = Math.max(0, this.selfRenderHeight - start);
                }
                return lines.slice(start, end);
            } catch {
                return lines;
            }
        };
        (patched as any).__leanOutputSpacing = true;
        proto.render = patched;
    } catch {
        /* never let a cosmetic patch break startup */
    }
}

function installGrouping(): void {
    try {
        const proto: any = (Container as any)?.prototype;
        if (!proto || typeof proto.render !== "function") return;
        if ((proto.render as any).__leanOutput) return;
        const base: (w: number) => string[] = proto.render;
        try {
            (proto as any)[CONTAINER_KEY] = base;
        } catch {
            /* ignore */
        }
        const patched = function (this: any, width: number): string[] {
            try {
                if (!enabled() || groupOff()) return base.call(this, width);
                const kids = this?.children;
                if (!Array.isArray(kids) || !kids.some(isToolChild)) return base.call(this, width);
                return renderGrouped(this, width, base);
            } catch {
                try {
                    return base.call(this, width);
                } catch {
                    return [];
                }
            }
        };
        (patched as any).__leanOutput = true;
        proto.render = patched;
    } catch {
        /* never let a cosmetic patch break startup */
    }
}

// ── hidden thinking label ─────────────────────────────────────────────────
// With `hideThinkingBlock` on, pi swaps the thinking content for one Text line
// holding `hiddenThinkingLabel`. There is no "no label" setting, so the label
// becomes a NUL sentinel and the child carrying it is dropped here. The child is
// wrapped in a MouseRegion on current pi, so the text is found by walking
// `.child` rather than checking the child itself.

const THINKING_SENTINEL = "\u0000lean-output\u0000";

/** True when `node` (or a MouseRegion-wrapped child) is the hidden-thinking label. */
function hasSentinel(node: any, depth = 0): boolean {
    if (!node || depth > 8) return false;
    if (typeof node.text === "string" && node.text.includes(THINKING_SENTINEL)) return true;
    return hasSentinel(node.child, depth + 1);
}

function isSpacer(node: any): boolean {
    try {
        return node instanceof Spacer;
    } catch {
        return false;
    }
}

function installThinkingLabel(): void {
    try {
        const proto: any = (AssistantMessageComponent as any)?.prototype;
        if (!proto || typeof proto.updateContent !== "function") return; // shape changed — bail
        if ((proto.updateContent as any).__leanOutput) return;

        const base = proto.updateContent;
        const patched = function (this: any, message: unknown, ...rest: any[]) {
            const result = base.call(this, message, ...rest);
            try {
                // Off means stock pi: leave the label (and pi's own Spacers) alone.
                if (!thinkingOn()) return result;
                const container = this.contentContainer;
                const children = container?.children;
                if (!Array.isArray(children)) return result;
                for (const child of [...children]) {
                    if (hasSentinel(child)) container.removeChild(child);
                }
                // Core pads a hidden-thinking block on both sides. With the
                // label gone the two Spacers sit adjacent (["", ""]); drop one
                // so prose follows a single blank line. Repeat so triplets
                // collapse too, whatever order the children arrived in.
                let collapsed = true;
                while (collapsed) {
                    collapsed = false;
                    const kids = container.children;
                    if (!Array.isArray(kids)) break;
                    for (let i = 0; i + 1 < kids.length; i++) {
                        if (isSpacer(kids[i]) && isSpacer(kids[i + 1])) {
                            container.removeChild(kids[i + 1]);
                            collapsed = true;
                            break;
                        }
                    }
                }
                // A textless tool-call turn is [Spacer, label]: with the label
                // gone a lone Spacer renders as a stray blank line between
                // runs. Core never builds a container holding only a Spacer (it
                // is only added alongside visible content), so a sole survivor
                // is always a removal leftover — drop it.
                const rest = container.children;
                if (Array.isArray(rest) && rest.length === 1 && isSpacer(rest[0])) {
                    container.removeChild(rest[0]);
                }
            } catch {
                // never let a cosmetic patch break a render
            }
            return result;
        };
        (patched as any).__leanOutput = true;
        proto.updateContent = patched;
    } catch {
        /* never let a cosmetic patch break startup */
    }
}

// ── toggle ────────────────────────────────────────────────────────────────

const STATUS_KEY = "lean";

/** Footer hint while anything is off, so stock output is not a mystery. */
function refreshStatus(ctx: any): void {
    try {
        const s = state();
        const text = !s.on
            ? "lean off"
            : !s.rows
              ? "lean rows off"
              : !s.thinking
                ? "lean label on"
                : undefined;
        ctx?.ui?.setStatus?.(STATUS_KEY, text);
    } catch {
        /* no UI (rpc/headless) */
    }
}

/** The definition a tool's rows should have right now, from what the chain gave us. */
function definitionFor(toolName: string): any {
    const base = state().bases.get(toolName);
    return owns(toolName) ? verbRenderers(toolName, base) : base;
}

/**
 * Give an existing row the other look. A row bakes in its definition and the
 * shell container that definition implies at construction, and `updateDisplay`
 * only clears/refills whichever container it picks *now* — so swapping the
 * definition alone would paint into a container that is not attached. This swaps
 * both: the definition, then the shell child (index 1, after pi's leading
 * Spacer), then asks the row to rebuild. Images are children of their own and
 * are re-added by `updateDisplay`, so they survive either direction.
 */
function restock(row: any): void {
    try {
        const toolName = row?.toolName;
        if (typeof toolName !== "string") return;
        if (!state().bases.has(toolName)) return; // never resolved through us
        if (typeof row.updateDisplay !== "function" || !Array.isArray(row.children)) return;
        const def = definitionFor(toolName);
        const shell = def?.renderShell ?? "default";
        const target = !def
            ? row.contentTextRegion
            : shell === "self"
              ? row.selfRenderContainer
              : row.contentBox;
        if (!target) return;
        row.toolDefinition = def;
        const kids = row.children;
        for (let i = 0; i < kids.length; i++) {
            if (
                kids[i] === row.contentBox ||
                kids[i] === row.selfRenderContainer ||
                kids[i] === row.contentTextRegion
            ) {
                kids[i] = target;
                break;
            }
        }
        if (typeof row.selfRenderHeight === "number") row.selfRenderHeight = 0;
        row.invalidate(); // ToolExecutionComponent.invalidate → updateDisplay
    } catch {
        /* leave the row looking as it did */
    }
}

/** The UI handle lives on the rows; the patches get no ctx of their own. */
function requestRender(): void {
    for (const row of state().components) {
        const ui = (row as any)?.ui;
        if (ui && typeof ui.requestRender === "function") {
            try {
                ui.requestRender();
            } catch {
                /* ignore */
            }
            return;
        }
    }
}

/**
 * Push the hidden-thinking label the switches ask for. `setHiddenThinkingLabel`
 * re-runs every assistant component's `updateContent` for us, which is how the
 * label comes back or goes away — and why the switch is skipped when nothing
 * changed (it rebuilds markdown).
 */
function syncLabel(ctx: any): void {
    const want = thinkingOn() ? THINKING_SENTINEL : undefined;
    const s = state();
    if (s.labelApplied === want) return;
    try {
        ctx?.ui?.setHiddenThinkingLabel?.(want);
        s.labelApplied = want;
    } catch {
        /* no UI (rpc/headless) */
    }
}

/**
 * Apply the switches to the running session. No reload: the label is synced
 * through the UI api and every live row is restocked in place.
 */
function apply(ctx: any): void {
    syncLabel(ctx);
    for (const row of [...state().components]) restock(row);
    requestRender();
    refreshStatus(ctx);
}

export default function leanOutput(pi: ExtensionAPI): void {
    pi.registerFlag("no-lean", {
        description: "Start with stock pi output; /lean turns lean-output back on",
        type: "boolean",
        default: false,
    });

    // Must register during load: registerToolRenderer asserts the extension is active.
    // Every tool resolves through here — ours when we own it, the next resolver
    // in the chain otherwise — and the check runs per row, so a toggle only
    // needs the rows restocked to take effect.
    pi.registerToolRenderer((toolName, next) => {
        const base = next();
        // Remember what the rest of the chain resolves to: /lean swaps rows
        // back to it (and forward to ours) without a reload.
        try {
            state().bases.set(toolName, base);
        } catch {
            /* ignore */
        }
        if (!owns(toolName)) return base;
        return verbRenderers(toolName, base);
    });

    pi.registerCommand("lean", {
        description: "Toggle condensed tool rows and hidden thinking label (on|off|rows|thinking|status)",
        getArgumentCompletions: (prefix) => {
            const all = ["on", "off", "status", "rows on", "rows off", "thinking on", "thinking off"];
            const p = prefix.trim().toLowerCase();
            const hits = all.filter((a) => a.startsWith(p));
            return hits.length ? hits.map((value) => ({ value, label: value })) : null;
        },
        handler: async (raw, ctx) => {
            const s = state();
            const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
            const part = words[0];
            const arg = words[1];
            const usage = "Usage: /lean [on|off|status|rows on|off|thinking on|off]";
            const flip = (value: boolean | undefined, current: boolean) =>
                value === undefined ? !current : value;
            const readBool = (v: string | undefined) =>
                v === undefined
                    ? undefined
                    : v === "on" || v === "true"
                      ? true
                      : v === "off" || v === "false"
                        ? false
                        : undefined;

            if (part === "status" || part === "?") {
                ctx.ui.notify(
                    `lean-output: ${s.on ? "on" : "off"} · rows ${s.rows ? "on" : "off"} · label ${s.thinking ? "hidden" : "shown"}` +
                        ` · ${KEEP.length ? `keep: ${KEEP.join(", ")}` : "all tools"}`,
                    "info",
                );
                return;
            }
            if (part === "rows" || part === "thinking") {
                if (
                    words.length > 2 ||
                    (arg !== undefined && readBool(arg) === undefined && arg !== "toggle")
                ) {
                    ctx.ui.notify(usage, "warning");
                    return;
                }
                const value = flip(readBool(arg === "toggle" ? undefined : arg), s[part]);
                s[part] = value;
            } else if (part === "" || part === "toggle" || part === "on" || part === "off") {
                if (words.length > 1) {
                    ctx.ui.notify(usage, "warning");
                    return;
                }
                s.on = part === "on" ? true : part === "off" ? false : !s.on;
            } else {
                ctx.ui.notify(usage, "warning");
                return;
            }
            apply(ctx);
            ctx.ui.notify(
                `lean-output: ${s.on ? "on" : "off"} · rows ${s.rows ? "on" : "off"} · label ${s.thinking ? "hidden" : "shown"}`,
                "info",
            );
        },
    });

    try {
        installGrouping();
    } catch {
        /* never let a cosmetic patch break startup */
    }
    try {
        installSpacingTrim();
    } catch {
        /* never let a cosmetic patch break startup */
    }
    try {
        installThinkingLabel();
    } catch {
        /* never let a cosmetic patch break startup */
    }

    pi.on("session_shutdown", () => {
        stopAllClocks();
    });

    pi.on("session_start", (ev: any, ctx: any) => {
        // A new session starts with no rows to tick and a fresh chat container;
        // the rows and definitions we tracked belong to the old one. Clearing on
        // a reload too: rows register again as they render.
        stopAllClocks();
        state().components.clear();
        state().bases.clear();
        // A rebuilt chat container starts with pi's default label again.
        state().labelApplied = undefined;
        // A fresh session re-derives the switches from the environment and
        // `--no-lean`; a reload (ctx.reload, i.e. /reload) keeps what /lean set.
        if (ev?.reason !== "reload") {
            const s = state();
            s.on = !isOff(process.env.PI_LEAN) && pi.getFlag("no-lean") !== true;
            s.rows = !isOff(process.env.PI_LEAN_ROWS);
            s.thinking = !isOff(process.env.PI_LEAN_THINKING);
        }
        try {
            const th = ctx?.ui?.theme;
            if (th && typeof th.fg === "function" && typeof th.bold === "function") state().theme = th;
        } catch {
            /* keep plain theme */
        }
        try {
            installGrouping();
        } catch {
            /* ignore */
        }
        try {
            installSpacingTrim();
        } catch {
            /* ignore */
        }
        try {
            installThinkingLabel();
        } catch {
            /* ignore */
        }
        // The label has to be set through the UI api (the patch only removes the
        // child it produces); `undefined` restores pi's default so a session that
        // starts with the part off looks stock.
        syncLabel(ctx);
        refreshStatus(ctx);
    });
}
