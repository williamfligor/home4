/**
 * minimal-footer — replaces Pi's built-in footer with a single line holding
 * only what's worth glancing at: context usage, the active model with its
 * thinking level, and extension statuses.
 *
 *   `16.6%/1.0M · opencode-go/deepseek-v4.1-flash • high · Go 1% / 3% / 72%`
 *
 * Context usage keeps the built-in thresholds (warning > 70%, error > 90%) and
 * the built-in `?/<window>` form while usage is unknown (just after a
 * compaction).
 *
 * The model part mirrors the stock footer: `provider/model`, with ` • <level>`
 * appended when the model reasons (` • thinking off` at level off, as the
 * built-in footer words it). `ctx.model` and `ctx.thinkingLevel` are live
 * getters, so `/model` and thinking-level changes need only a repaint, which
 * the model_select / thinking_level_select handlers request.
 *
 * Extension statuses are read from footerData, so setStatus() output — the
 * OpenCode Go quota, the web-gate globe — lands on the same line. Keys listed
 * in HIDDEN_STATUS_KEYS are dropped: pi-rewind is what sets "rewind", and it
 * exposes no setting or env var to turn its `◆ N checkpoints` status off, so
 * the filtering happens here.
 *
 * Fitting: the context gauge and the extension statuses are the parts that
 * carry numbers, so the model is what gives way on a narrow terminal. Each
 * spelling of the name is offered with the thinking level first and without it
 * second, so the level is only surrendered when no spelling fits with it;
 * after that come the elided forms. When even an elided id is too wide, the
 * gauge sheds its window (`16.6%/1.0M` → `17%`) to buy the model room; if that
 * still fails the model is dropped for this render so the quota stays whole.
 * Only when the remaining parts overflow is the line truncated.
 *
 * Abbreviation is derived, not tabulated. These names are compounds spoken as
 * two halves, so every lowercase word of 8+ letters folds to its first letter
 * plus the letter that opens its second half — the consonant nearest the
 * middle: `deepseek-v4.1-flash` → `ds-v4.1-flash`, `opencode-go` → `oc-go`,
 * `openrouter` → `or`, `muse-spark-1.3-contributor` → `muse-spark-1.3-cb`.
 * Words under 8 letters (`flash`, `muse`, `pro`), versions (`1.3`) and quant
 * tags (`30b`) are left alone, so short distinguishing variants survive.
 * When even the folded name is too wide, its long trailing words are dropped
 * (`oc-go/muse-spark-1.3`), which keeps the provider and the level.
 * Abbreviated spellings are the default (`oc-go/ds-v4.1-flash • high`);
 * PI_FOOTER_ABBREV=auto uses them only when the full name will not fit, and
 * =off disables them so only elision remains.
 *
 * Everything else the stock footer shows (cwd/session, tokens in/out, cache
 * read/write and hit rate, cost, auto-compaction marker) is deliberately
 * dropped. Delete this file to get the stock footer back.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

/**
 * Status keys this footer will not render. `rewind` is pi-rewind's
 * `◆ N checkpoints`; the plugin has no config to disable it.
 */
const HIDDEN_STATUS_KEYS = new Set(["rewind"]);

const SEPARATOR = " · ";
const SEPARATOR_WIDTH = SEPARATOR.length;

/** Below this many cells an elided model id is noise — drop the model instead. */
const MIN_ELIDED = 12;

const ANSI = /\x1b\[[0-9;]*m/g;

/** Visible cells of a styled string; the plain length is only a fallback. */
function cells(text: string): number {
    try {
        return visibleWidth(text);
    } catch {
        return text.replace(ANSI, "").length;
    }
}

function sumCells(parts: string[]): number {
    let total = 0;
    for (const p of parts) total += cells(p);
    return total;
}

/** `deepseek-v4.1-flash` → `deepse…flash`: keep both ends, which is what names the model. */
function elideMiddle(text: string, max: number): string {
    if (cells(text) <= max) return text;
    if (max <= 1) return "…";
    const head = Math.ceil((max - 1) / 2);
    const tail = max - 1 - head;
    return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

// ── abbreviation ─────────────────────────────────────────────────────────────

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/**
 * `deepseek` → `ds`, `opencode` → `oc`, `openrouter` → `or`: keep the first
 * letter and the letter that opens the second half, i.e. the consonant nearest
 * the middle (ties go to the later one). These names are compounds, so that
 * boundary is where the speaker breaks them.
 */
function foldWord(word: string): string {
    const middle = word.length / 2;
    let split = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < word.length - 1; i++) {
        if (VOWELS.has(word[i]!)) continue;
        const distance = Math.abs(i - middle);
        if (distance <= best) {
            best = distance;
            split = i;
        }
    }
    if (split < 0) return word;
    return `${word[0]}${word[split]}`;
}

const WORD = /[A-Za-z]+/g;

/**
 * Fold every long lowercase word in a name, not just the leading one:
 * `deepseek-v4.1-flash` → `ds-v4.1-flash`, `muse-spark-1.3-contributor` →
 * `muse-spark-1.3-cb`. Words under 8 letters (`flash`, `muse`, `pro`), version
 * runs (`1.3`) and quant tags (`30b`) are left alone, so a short variant name
 * keeps its distinguishing tail.
 */
function abbrevName(name: string): string {
    return name.replace(WORD, (word) => (word.length >= 8 && /^[a-z]+$/.test(word) ? foldWord(word) : word));
}

/**
 * Progressive trailing-word drops: `muse-spark-1.3-contributor` →
 * `muse-spark-1.3`. Only long alphabetic tail words go (8+ letters, the same
 * bar as the fold) — versions (`1.3`), quant tags (`30b`) and short variants
 * (`flash`, `mini`, `pro`) stay put — and never below two segments. This is the
 * rung for a name whose folded form is still too wide.
 */
function trimTail(name: string): string[] {
    const out: string[] = [];
    let current = name;
    for (;;) {
        const parts = current.split("-");
        if (parts.length < 3) break;
        const last = parts[parts.length - 1]!;
        if (last.length < 8 || !/^[a-z]+$/i.test(last)) break;
        current = parts.slice(0, -1).join("-");
        out.push(current);
    }
    return out;
}

/** `prefer` (default) abbreviates first; `auto` only when the full name will not fit. */
function abbrevMode(): "prefer" | "auto" | "off" {
    const raw = (process.env.PI_FOOTER_ABBREV ?? "").trim();
    if (/^(0|off|false|no|never)$/i.test(raw)) return "off";
    if (/^(auto|fallback)$/i.test(raw)) return "auto";
    return "prefer";
}

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 100000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

// Same normalization the built-in footer applies, so a status carrying a
// newline or trailing padding cannot break the single-line layout.
function sanitizeStatusText(text: string): string {
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

function contextPart(ctx: ExtensionContext, theme: Theme): { full: string; short: string } | null {
    let usage: ReturnType<ExtensionContext["getContextUsage"]>;
    try {
        usage = ctx.getContextUsage();
    } catch {
        // A session-replacing dialog invalidates the runner and this getter
        // throws; a footer render must never propagate that.
        return null;
    }
    if (!usage) return null;
    const window = formatTokens(usage.contextWindow ?? 0);
    if (usage.percent === null) {
        return { full: theme.fg("dim", `?/${window}`), short: theme.fg("dim", "?") };
    }
    const color = usage.percent > 90 ? "error" : usage.percent > 70 ? "warning" : "dim";
    return {
        full: theme.fg(color, `${usage.percent.toFixed(1)}%/${window}`),
        short: theme.fg(color, `${Math.round(usage.percent)}%`),
    };
}

/** A model spelling: one plain run of text plus an optional dimmed suffix. */
type ModelForm = { text: string; suffix?: string };

/**
 * The model spellings to try, plus the id the elided fallback shortens.
 *
 * Every name is offered with the thinking level first and without it second, so
 * the level is only surrendered once *no* spelling fits with it. A short
 * abbreviation therefore beats a long name that has lost its level: at 64
 * cells `oc-go/ds-v4.1-flash • high` (28) wins over
 * `opencode-go/deepseek-v4.1-flash` (32).
 */
function modelForms(ctx: ExtensionContext): { forms: ModelForm[]; elideBase: string | null } {
    const model = ctx.model;
    if (!model) return { forms: [], elideBase: null };
    const id = String(model.id ?? "");
    if (!id) return { forms: [], elideBase: null };
    const provider = String(model.provider ?? "");
    let suffix: string | undefined;
    if (model.reasoning) {
        const level = ctx.thinkingLevel;
        suffix = !level || level === "off" ? " • thinking off" : ` • ${level}`;
    }

    const full = provider ? `${provider}/${id}` : id;
    const short = provider ? `${abbrevName(provider)}/${abbrevName(id)}` : abbrevName(id);
    const shortId = abbrevName(id);
    const mode = abbrevMode();

    // Falling order of detail: provider first, then the bare id. `prefer` leads
    // with the folded spellings, `auto` with the full ones, `off` skips folding.
    const bases: string[] = [];
    const pushBase = (name: string) => {
        if (name && !bases.includes(name)) bases.push(name);
    };
    if (mode === "off") {
        pushBase(full);
        if (provider) pushBase(id);
    } else if (mode === "auto") {
        pushBase(full);
        pushBase(short);
        if (provider) pushBase(id);
        pushBase(shortId);
    } else {
        pushBase(short);
        pushBase(shortId);
        pushBase(full);
        if (provider) pushBase(id);
    }

    // Each spelling is followed by its trailing-word drops, so `oc-go/muse-spark-1.3`
    // is tried before the provider is surrendered.
    const names: string[] = [];
    for (const base of bases) {
        if (!names.includes(base)) names.push(base);
        for (const trimmed of trimTail(base)) {
            if (!names.includes(trimmed)) names.push(trimmed);
        }
    }

    const forms: ModelForm[] = [];
    if (suffix) for (const name of names) forms.push({ text: name, suffix });
    for (const name of names) forms.push({ text: name });
    return { forms, elideBase: mode === "off" ? id : shortId };
}

function renderForm(form: ModelForm, theme: Theme): string {
    return form.suffix ? form.text + theme.fg("dim", form.suffix) : form.text;
}

/**
 * The widest model spelling that fits `budget` cells — full, then abbreviated,
 * then elided — or null: the quota and context gauge matter more than a name.
 */
function fitModelPart(ctx: ExtensionContext, theme: Theme, budget: number): string | null {
    if (budget <= 0) return null;
    const { forms, elideBase } = modelForms(ctx);
    for (const form of forms) {
        const text = renderForm(form, theme);
        if (cells(text) <= budget) return text;
    }
    if (!elideBase || budget < MIN_ELIDED) return null;
    return elideMiddle(elideBase, budget);
}

export default function (pi: ExtensionAPI) {
    // The live footer registers a repaint here; a full layout change is not
    // needed when only the model or thinking level moves.
    let requestRender: (() => void) | null = null;

    pi.on("model_select", () => requestRender?.());
    pi.on("thinking_level_select", () => requestRender?.());

    pi.on("session_start", async (_event, ctx) => {
        // The footer only exists in the interactive TUI.
        if (ctx.mode !== "tui") return;
        ctx.ui.setFooter((tui, theme, footerData) => {
            const render = () => {
                try {
                    tui.requestRender();
                } catch {
                    // Torn down; the next session_start installs a new footer.
                }
            };
            requestRender = render;
            const unsubscribe = footerData.onBranchChange(render);
            return {
                dispose() {
                    unsubscribe();
                    // Only clear our own hook: a replacement footer may already own it.
                    if (requestRender === render) requestRender = null;
                },
                invalidate() {},
                render(width: number): string[] {
                    try {
                        const statuses: string[] = [];
                        for (const [key, value] of footerData.getExtensionStatuses()) {
                            if (HIDDEN_STATUS_KEYS.has(key)) continue;
                            const text = sanitizeStatusText(value);
                            if (text) statuses.push(text);
                        }

                        const context = contextPart(ctx, theme);
                        // Wide enough for `16.6%/1.0M` first, then `17%` — but only when
                        // shedding the window actually buys the model some room.
                        const contextForms: (string | null)[] = [];
                        if (context) contextForms.push(context.full);
                        if (context && cells(context.short) < cells(context.full)) {
                            contextForms.push(context.short);
                        }
                        if (contextForms.length === 0) contextForms.push(null);

                        const line = (contextText: string | null, model: string | null): string => {
                            const parts: string[] = [];
                            if (contextText) parts.push(contextText);
                            if (model) parts.push(model);
                            parts.push(...statuses);
                            return parts.join(theme.fg("dim", SEPARATOR));
                        };

                        // The context gauge and statuses are fixed; the model takes the rest.
                        for (const contextText of contextForms) {
                            const fixed = contextText ? [contextText, ...statuses] : statuses;
                            const fixedWidth =
                                sumCells(fixed) +
                                (fixed.length > 1 ? SEPARATOR_WIDTH * (fixed.length - 1) : 0);
                            const budget = width - fixedWidth - (fixed.length > 0 ? SEPARATOR_WIDTH : 0);
                            const model = fitModelPart(ctx, theme, budget);
                            if (model)
                                return [
                                    truncateToWidth(line(contextText, model), width, theme.fg("dim", "...")),
                                ];
                        }

                        // Nothing fit alongside a model: keep the numbers, drop the model,
                        // and shed the context window too if even that is too wide.
                        const fallbacks = [context?.full, context?.short, null];
                        for (const contextText of fallbacks) {
                            const candidate = line(contextText ?? null, null);
                            if (candidate && cells(candidate) <= width) return [candidate];
                        }
                        const fallback = line(context ? context.full : null, null);
                        if (!fallback) return [];
                        return [truncateToWidth(fallback, width, theme.fg("dim", "..."))];
                    } catch {
                        return [];
                    }
                },
            };
        });
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        requestRender = null;
        try {
            ctx.ui.setFooter(undefined);
        } catch {
            // Shutdown already tore the footer down.
        }
    });
}
