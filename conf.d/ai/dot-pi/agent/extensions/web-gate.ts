/**
 * web-gate — one switch for every tool that reaches the web.
 *
 * Packages that provide web tools register their names here; other extensions
 * may call registerWebGate() for their own. The gate starts closed: web tools are
 * stripped at session start until the user opens it with --web-on or /web-on.
 *
 * SECURITY INVARIANT — only explicit user action can open the gate. The model has
 * no tool that can toggle tools, and the gate re-asserts the closed state at
 * session start, on tree navigation, and at the start of every turn
 * (agent_start). Tool-state changes from any other source are therefore reverted
 * before the model can act:
 *   - /tools restoring an enabled set from branch history,
 *   - dynamic tool re-registration re-adding an allowlisted web tool,
 *   - pi's --tools allowlist refreshing.
 *
 * PI_WEB_ON mirrors the user's intent, never the observed tool state, so nothing
 * else can propagate web access to subagents. The main process clears it at
 * session start, so a /web-on from an earlier session in the same process cannot
 * carry over. Subagent children are separate pi processes: they inherit the
 * parent's grant through the environment (a child does not receive the parent's
 * CLI flags), never clear it, and so nested spawns keep the state their parent
 * granted.
 *
 * Shared state lives on globalThis so several extension files can register tools
 * into the same gate without sharing module scope.
 *
 * The commands and the session_start handler are registered in this extension's
 * default export rather than in registerWebGate(), so they are re-established on
 * /reload — globalThis state survives a reload, pi's registrations do not.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATE_KEY = "__pi_web_gate";
const ENV_KEY = "PI_WEB_ON";
const GLOBE = "\u{f0ac} "; // nf-fa-globe

/** Packages whose tools are gated wholesale, matched against sourceInfo.source. */
const GATED_SOURCES = ["donsetch", "pi-web-access"];

/**
 * Names for the versions of those packages in use. donsetch (npm) registers its
 * tools at session_start from the MCP binary's tools/list, so a later version can
 * add a name this list does not have; discoverGated() covers that by source, and
 * runs before every assert. pi-web-access (npm) supplies the researcher builtin's
 * fetch_content / get_search_content. A name no package registered is a no-op:
 * the gate only strips active tools, and /web-on reports only names the registry
 * actually has.
 */
const EXPLICIT_TOOLS = [
    "web_fetch",
    "web_search",
    "web_crawl",
    "web_screenshot",
    "fetch_content",
    "get_search_content",
];

interface GateState {
    toolNames: string[];
    /**
     * The user's explicit intent for this session: set by /web-on, by the
     * --web-on flag at session start, or inherited from a parent through
     * PI_WEB_ON in a subagent process. Never inferred from tool state.
     */
    enabled: boolean;
    /** Set after the first discovery failure, so the warning is said once. */
    discoveryWarned?: boolean;
}

function state(): GateState {
    const shared = globalThis as Record<string, unknown>;
    if (!shared[STATE_KEY]) {
        shared[STATE_KEY] = { toolNames: [], enabled: false };
    }
    return shared[STATE_KEY] as GateState;
}

// ── shared helpers ──

function syncEnv(gate: GateState) {
    if (gate.enabled) {
        process.env[ENV_KEY] = "1";
        return;
    }
    // A subagent child only ever sets the variable: the grant its parent made is
    // what lets a nested spawn keep web access, so clearing here would break it.
    if (process.env.PI_SUBAGENT_CHILD !== "1") delete process.env[ENV_KEY];
}

function refreshStatus(pi: ExtensionAPI, ctx: ExtensionContext) {
    const gate = state();
    const active = pi.getActiveTools();
    const anyActive = gate.toolNames.some((name) => active.includes(name));
    ctx.ui.setStatus("web", anyActive ? GLOBE : undefined);
}

/** Strip every gated tool from the active set, unless the user opened the gate. */
function assertGate(pi: ExtensionAPI) {
    const gate = state();
    if (gate.enabled) return;
    const active = pi.getActiveTools();
    const kept = active.filter((name) => !gate.toolNames.includes(name));
    if (kept.length < active.length) pi.setActiveTools(kept);
}

// ── public API: other extensions register their tools here ──

export function registerWebGate(_pi: ExtensionAPI, toolName: string) {
    const gate = state();
    if (!gate.toolNames.includes(toolName)) gate.toolNames.push(toolName);
}

/**
 * Add tools belonging to a gated package, whatever their names are. Runs before
 * every assert, so a tool registered after our session_start handler is still
 * stripped at the next turn start, before the model can act.
 */
function discoverGated(pi: ExtensionAPI, ctx: ExtensionContext) {
    try {
        for (const tool of pi.getAllTools()) {
            const info = (tool as { sourceInfo?: { source?: string } }).sourceInfo?.source ?? "";
            const source = String(info);
            if (GATED_SOURCES.some((needle) => source.includes(needle))) {
                registerWebGate(pi, tool.name);
            }
        }
    } catch (error) {
        // Never fail open quietly: the explicit names stay gated, but a tool a
        // gated package added later would not be, and the user has to know. This
        // runs on every turn, so the warning is said once per session.
        const gate = state();
        if (gate.discoveryWarned) return;
        gate.discoveryWarned = true;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
            `web-gate: tool discovery failed (${message}); web tools not in the explicit list are NOT gated`,
            "warning",
        );
    }
}

// ── extension entry ──

export default function (pi: ExtensionAPI) {
    // Registered so pi accepts --web-on and lists it in --help.
    pi.registerFlag("web-on", {
        description: "Start with all web tools enabled and bypass the web gate completely",
        type: "boolean",
        default: false,
    });

    const gate = state();
    const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";

    for (const name of EXPLICIT_TOOLS) registerWebGate(pi, name);

    /** The user's intent for this process, derived from flags and inherited env. */
    function intentEnabled(): boolean {
        if (isSubagent) return pi.getFlag("web-on") === true || process.env[ENV_KEY] === "1";
        // The main process trusts only the CLI flag: PI_WEB_ON left over from an
        // earlier session in this process is stale.
        return pi.getFlag("web-on") === true;
    }

    /**
     * Names the gate intends to gate, filtered to what pi has registered.
     * Undefined means the registry could not be read, in which case every gate
     * name is kept so /web-on stays conservative rather than reporting nothing.
     */
    function registeredNames(): Set<string> | undefined {
        try {
            return new Set(pi.getAllTools().map((tool) => tool.name));
        } catch {
            return undefined;
        }
    }

    pi.registerCommand("web-on", {
        description: "Enable all web-browsing tools",
        handler: async (_args, ctx) => {
            const active = pi.getActiveTools();
            const registered = registeredNames();
            const gated = registered
                ? gate.toolNames.filter((name) => registered.has(name))
                : [...gate.toolNames];
            const alreadyOn = gated.filter((name) => active.includes(name));
            const missing = gated.filter((name) => !active.includes(name));

            if (missing.length === 0) {
                ctx.ui.notify(
                    alreadyOn.length > 0
                        ? `Web tools already enabled: ${alreadyOn.join(", ")}`
                        : "No registered web tools to enable",
                    alreadyOn.length > 0 ? "info" : "warning",
                );
            } else {
                pi.setActiveTools([...active, ...missing]);
                const suffix = alreadyOn.length > 0 ? ` (already on: ${alreadyOn.join(", ")})` : "";
                ctx.ui.notify(`Enabled: ${missing.join(", ")}${suffix}`, "info");
            }

            gate.enabled = true;
            syncEnv(gate); // subagents inherit the grant
            refreshStatus(pi, ctx);
        },
    });

    pi.registerCommand("web-off", {
        description: "Disable all web-browsing tools",
        handler: async (_args, ctx) => {
            const active = pi.getActiveTools();
            const kept = active.filter((name) => !gate.toolNames.includes(name));
            if (kept.length === active.length) {
                ctx.ui.notify("Web tools already disabled", "info");
            } else {
                pi.setActiveTools(kept);
                ctx.ui.notify("Web tools disabled", "info");
            }
            gate.enabled = false;
            syncEnv(gate); // stop propagating to subagents
            refreshStatus(pi, ctx);
        },
    });

    /** Discover, then apply the gate (or the globe), then reconcile the env var. */
    function reconcile(ctx: ExtensionContext) {
        discoverGated(pi, ctx);
        if (gate.enabled) {
            refreshStatus(pi, ctx);
        } else {
            assertGate(pi);
        }
        syncEnv(gate);
    }

    pi.on("session_start", (event, ctx) => {
        // A reload keeps the current toggle: globalThis survives it, and the user
        // did not ask for their choice to be undone.
        if (event.reason !== "reload") {
            gate.enabled = intentEnabled();
            gate.discoveryWarned = false;
        }
        reconcile(ctx);
    });

    // tools.ts can restore enabled tools from branch history on navigation. Keep
    // the user's intent and re-assert; the turn-start assert covers it anyway,
    // whatever order the handlers run in.
    pi.on("session_tree", (_event, ctx) => reconcile(ctx));

    // Before the model can act: undo any tool-state change made since last turn
    // (dynamic re-registration, a /tools restore) and resync the env var.
    pi.on("agent_start", (_event, ctx) => reconcile(ctx));
}
