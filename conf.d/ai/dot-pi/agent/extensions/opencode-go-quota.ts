/**
 * opencode-go-quota — OpenCode Go plan usage in the Pi status bar.
 *
 * Shows the rolling 5-hour, weekly (7d) and monthly (30d) usage percentages
 * from `GET <origin>/zen/go/v1/usage`, authenticated with the same credential
 * Pi uses for the `opencode-go` provider (model registry, then
 * OPENCODE_GO_API_KEY / OPENCODE_API_KEY, then auth.json).
 *
 * Status line: `Go 1% / 3% / 72%` — the numbers are the rolling 5-hour,
 * weekly and monthly windows, in that order.
 *   - each number is colored dim < 70% ≤ warning < 90% ≤ error
 *
 * `/goquota` prints the same windows with labels and reset countdowns, and
 * bypasses the refresh throttle.
 *
 * Tuning (env):
 *   OPENCODE_GO_QUOTA_INTERVAL_MS  poll interval, default 60000
 *   OPENCODE_GO_QUOTA_ORIGIN       override https://opencode.ai
 *   OPENCODE_GO_QUOTA_DISABLED=1   disable polling entirely
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "opencode-go-quota";
const DEFAULT_ORIGIN = "https://opencode.ai";
const USAGE_PATH = "/zen/go/v1/usage";
const DEFAULT_INTERVAL_MS = 60_000;
// Why: a finished turn is the natural moment for fresh numbers, but a burst of
// short turns must not become a burst of requests.
const MIN_REFRESH_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const WARN_PERCENT = 70;
const CRITICAL_PERCENT = 90;
const PROVIDER_IDS = ["opencode-go", "opencode", "opencode-zen"];

type UsageWindow = { status?: string; percent?: number; resetsAt?: string };
type Usage = { rolling?: UsageWindow; weekly?: UsageWindow; monthly?: UsageWindow };
type Theme = ExtensionContext["ui"]["theme"];

const WINDOWS: ReadonlyArray<{ label: string; key: keyof Usage }> = [
    { label: "5h", key: "rolling" },
    { label: "weekly", key: "weekly" },
    { label: "monthly", key: "monthly" },
];

function intervalMs(): number {
    const raw = Number(process.env.OPENCODE_GO_QUOTA_INTERVAL_MS);
    return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_INTERVAL_MS;
}

function origin(): string {
    const raw = process.env.OPENCODE_GO_QUOTA_ORIGIN?.trim();
    return (raw || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

function percentOf(window: UsageWindow | undefined): number | null {
    const value = window?.percent;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, value));
}

function usageFrom(body: unknown): Usage | null {
    if (!body || typeof body !== "object") return null;
    const record = body as Record<string, unknown>;
    const candidate = (record.usage ?? record) as Record<string, unknown>;
    const usage: Usage = {};
    let found = false;
    for (const { key } of WINDOWS) {
        const window = candidate[key];
        if (window && typeof window === "object" && percentOf(window as UsageWindow) !== null) {
            usage[key] = window as UsageWindow;
            found = true;
        }
    }
    return found ? usage : null;
}

function formatCountdown(resetsAt: string | undefined): string | null {
    if (!resetsAt) return null;
    const at = Date.parse(resetsAt);
    if (!Number.isFinite(at)) return null;
    const minutes = Math.floor((at - Date.now()) / 60_000);
    if (minutes <= 0) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`;
}

function colorFor(theme: Theme, percent: number): string {
    if (percent >= CRITICAL_PERCENT) return theme.fg("error", `${Math.round(percent)}%`);
    if (percent >= WARN_PERCENT) return theme.fg("warning", `${Math.round(percent)}%`);
    return theme.fg("dim", `${Math.round(percent)}%`);
}

function renderStatus(theme: Theme, usage: Usage): string {
    const parts: string[] = [];
    for (const { key } of WINDOWS) {
        const percent = percentOf(usage[key]);
        if (percent === null) continue;
        parts.push(colorFor(theme, percent));
    }
    if (parts.length === 0) return "";
    return `${theme.fg("accent", "Go")} ${parts.join(theme.fg("dim", " / "))}`;
}

function describeWindow(name: string, window: UsageWindow | undefined): string {
    const percent = percentOf(window);
    if (percent === null) return `${name} n/a`;
    const countdown = formatCountdown(window?.resetsAt);
    const reset = countdown ? ` (resets in ${countdown})` : "";
    return `${name} ${Math.round(percent)}%${reset}`;
}

function readStoredKey(): string | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf-8"));
        if (!parsed || typeof parsed !== "object") return undefined;
        for (const [provider, credential] of Object.entries(parsed as Record<string, unknown>)) {
            if (!provider.includes("opencode")) continue;
            const value = credential as { type?: unknown; key?: unknown } | null;
            if (value?.type === "api_key" && typeof value.key === "string" && value.key.trim()) {
                return value.key.trim();
            }
        }
    } catch {
        // Missing or unreadable auth.json just means no stored credential.
    }
    return undefined;
}

async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
    const explicit = process.env.OPENCODE_GO_API_KEY?.trim();
    if (explicit) return explicit;
    for (const provider of PROVIDER_IDS) {
        try {
            const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
            if (key?.trim()) return key.trim();
        } catch {
            // Unknown provider or unavailable auth store — try the next source.
        }
    }
    const envKey = process.env.OPENCODE_API_KEY?.trim();
    return envKey || readStoredKey();
}

async function requestUsage(apiKey: string): Promise<Usage> {
    const response = await fetch(`${origin()}${USAGE_PATH}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`usage request failed (HTTP ${response.status})`);
    }
    const usage = usageFrom(await response.json());
    if (!usage) throw new Error("usage response had no window data");
    return usage;
}

export default function (pi: ExtensionAPI) {
    let paintContext: ExtensionContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let usage: Usage | null = null;
    let lastFetchAt = 0;
    let lastError: string | null = null;
    let inFlight: Promise<void> | null = null;

    // Why: a session-replacing dialog invalidates the runner and its ctx.ui
    // getter throws; losing the paint must never escape into an uncaught error.
    function paint(text: string | undefined): void {
        const ctx = paintContext;
        if (!ctx) return;
        try {
            ctx.ui.setStatus(STATUS_KEY, text || undefined);
        } catch {
            paintContext = null;
        }
    }

    function repaint(): void {
        const ctx = paintContext;
        if (!ctx || !usage) return;
        try {
            paint(renderStatus(ctx.ui.theme, usage));
        } catch {
            paintContext = null;
        }
    }

    async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
        if (inFlight) return inFlight;
        if (!force && Date.now() - lastFetchAt < MIN_REFRESH_INTERVAL_MS) return;
        inFlight = (async () => {
            try {
                const apiKey = await resolveApiKey(ctx);
                if (!apiKey) {
                    lastError = "no OpenCode credential found";
                    return;
                }
                usage = await requestUsage(apiKey);
                lastFetchAt = Date.now();
                lastError = null;
                repaint();
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                if (!usage) paint(null);
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    }

    function stop(): void {
        if (timer) clearInterval(timer);
        timer = null;
        paint(null);
        paintContext = null;
    }

    pi.on("session_start", async (event, ctx) => {
        if (process.env.OPENCODE_GO_QUOTA_DISABLED === "1") return;
        // The status line is a TUI affordance; print/json runs pay nothing.
        if (ctx.mode !== "tui") return;
        paintContext = ctx;
        // Why: /reload re-registers the session; keep the poller and repaint the
        // numbers already known instead of blanking the footer and refetching.
        if (event.reason === "reload") {
            repaint();
            void refresh(ctx);
            return;
        }
        repaint();
        void refresh(ctx, true);
        if (!timer) {
            timer = setInterval(() => {
                if (paintContext) void refresh(paintContext);
            }, intervalMs());
            if (typeof timer.unref === "function") timer.unref();
        }
    });

    pi.on("agent_settled", async (_event, ctx) => {
        if (!paintContext) return;
        void refresh(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        stop();
        if (ctx && ctx.mode === "tui") {
            try {
                ctx.ui.setStatus(STATUS_KEY, undefined);
            } catch {
                // Shutdown already tore the footer down.
            }
        }
    });

    pi.registerCommand("goquota", {
        description: "Show OpenCode Go usage (5h / weekly / monthly)",
        handler: async (_args, ctx) => {
            // Why: the command can run before session_start painted anything (and
            // always can when the extension is loaded later); adopt its ctx so a
            // successful refresh also lands in the status bar.
            if (!paintContext && ctx.mode === "tui" && process.env.OPENCODE_GO_QUOTA_DISABLED !== "1") {
                paintContext = ctx;
            }
            await refresh(ctx, true);
            if (!usage) {
                ctx.ui.notify(`OpenCode Go usage unavailable: ${lastError ?? "unknown error"}`, "error");
                return;
            }
            const detail = WINDOWS.map(({ label, key }) => describeWindow(label, usage?.[key])).join(" · ");
            ctx.ui.notify(detail, "info");
        },
    });
}
