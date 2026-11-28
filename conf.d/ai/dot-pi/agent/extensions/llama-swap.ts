/**
 * llama-swap as a Pi provider.
 *
 * Pi's built-in llama.cpp provider reads the llama.cpp router catalog, which
 * offers models that are `loaded`, `sleeping`, or `unloaded` with
 * `source: "preset"`. llama-swap reports every model it can start as plain
 * `unloaded`, so the built-in sees one model at a time. This provider reads
 * llama-swap's /v1/models and registers the whole catalog; llama-swap starts a
 * model when the first request reaches it.
 *
 * The endpoint comes from LLAMA_BASE_URL (conf.d/ai/mise.local.toml, which is
 * git-ignored), so no hostname lives in this repo. LLAMA_API_KEY is optional
 * and is sent as a bearer token when set.
 *
 * A shell env is not always there: the paseo and herdr daemons spawn pi from
 * systemd with a fixed Environment= list, so a session started from the phone
 * (or any daemon-launched session) sees no LLAMA_BASE_URL and used to fall back
 * to the localhost default — nothing is listening there, so the first request
 * failed as `ECONNREFUSED 127.0.0.1:9931`. No extra config file for that: the
 * endpoint pi itself persisted in models-store.json is reused, since every model
 * entry carries the baseUrl it was registered with. Precedence: env, then the
 * persisted catalog, then the localhost default. A machine that has never had
 * the env set has no persisted catalog either, so it still needs LLAMA_BASE_URL
 * once (a models.json stub cannot carry the hostname — that file is tracked).
 *
 * The catalog is persisted to models-store.json, so model selection and
 * `pi --list-models` work offline and before the first refresh completes.
 *
 * Capabilities llama-swap publishes are used as-is: n_ctx for the context
 * window, architecture.input_modalities for images. It does not publish the
 * chat template, so reasoning is inferred from the id (Qwen3 thinking templates
 * take enable_thinking) and every other model is treated as non-reasoning.
 */

import type { Model, Provider } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "llama-cpp";
const DEFAULT_SERVER_URL = "http://127.0.0.1:9931";
const FALLBACK_CONTEXT_WINDOW = 128_000;
const CATALOG_TIMEOUT_MS = 15_000;

type ChatModel = Model<"openai-completions">;

interface LlamaSwapEntry {
    id: string;
    context_window?: number;
    context_length?: number;
    architecture?: { input_modalities?: string[] };
    meta?: { n_ctx?: number };
}

/**
 * Endpoint learned from the catalog pi persisted last time, for launch paths
 * that carry no shell env (systemd-spawned daemons). Set from `stored.models`
 * before the first fetch, so it also applies to that fetch.
 */
let learnedServerUrl: string | undefined;

/** LLAMA_BASE_URL without a trailing slash or /v1, so both forms work. */
function serverRoot(): string {
    const configured = process.env.LLAMA_BASE_URL?.trim() || learnedServerUrl || DEFAULT_SERVER_URL;
    return configured.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

function inferenceUrl(): string {
    return `${serverRoot()}/v1`;
}

/** llama-swap is usually keyless; a non-"none" key is sent as a bearer token. */
function apiKey(): string {
    return process.env.LLAMA_API_KEY?.trim() || "none";
}

function contextWindow(entry: LlamaSwapEntry): number {
    for (const candidate of [entry.meta?.n_ctx, entry.context_window, entry.context_length]) {
        if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return candidate;
    }
    return FALLBACK_CONTEXT_WINDOW;
}

/** Only Qwen3 ids are known to expose a thinking template through this server. */
function isReasoningModel(id: string): boolean {
    return /^qwen3/iu.test(id);
}

function toModel(entry: LlamaSwapEntry): ChatModel {
    const reasoning = isReasoningModel(entry.id);
    const context = contextWindow(entry);
    return {
        type: "chat",
        id: entry.id,
        name: entry.id,
        provider: PROVIDER_ID,
        api: "openai-completions",
        baseUrl: inferenceUrl(),
        reasoning,
        input:
            entry.architecture?.input_modalities?.includes("image") === true ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: context,
        maxTokens: context,
        compat: {
            supportsStore: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: true,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
            ...(reasoning && { thinkingFormat: "qwen-chat-template" }),
        },
        ...(reasoning && {
            thinkingLevelMap: {
                off: "off",
                minimal: null,
                low: null,
                medium: "medium",
                high: null,
                xhigh: null,
            },
        }),
    };
}

function isChatModel(value: unknown): value is ChatModel {
    const model = value as ChatModel | undefined;
    return model?.provider === PROVIDER_ID && model.api === "openai-completions";
}

async function fetchCatalog(signal: AbortSignal): Promise<LlamaSwapEntry[]> {
    const headers = new Headers();
    const key = apiKey();
    if (key !== "none") headers.set("Authorization", `Bearer ${key}`);
    const response = await fetch(`${inferenceUrl()}/models`, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`llama-swap returned HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: unknown };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    return entries.filter(
        (entry): entry is LlamaSwapEntry =>
            typeof entry === "object" && entry !== null && typeof (entry as LlamaSwapEntry).id === "string",
    );
}

export default function llamaSwap(pi: ExtensionAPI) {
    // Live catalog. Restored from models-store.json on startup and replaced by
    // each successful refresh; an unreachable server keeps what is already here.
    let catalog: ChatModel[] = [];

    const provider: Provider<"openai-completions"> = {
        id: PROVIDER_ID,
        name: "llama.cpp (llama-swap)",
        baseUrl: inferenceUrl(),
        auth: {
            apiKey: {
                name: "llama-swap server",
                // Env-only setup: the URL is the credential, the key is optional.
                check: async () => ({ type: "api_key", source: "LLAMA_BASE_URL" }),
                resolve: async () => ({
                    auth: { apiKey: apiKey(), baseUrl: inferenceUrl() },
                    env: { LLAMA_BASE_URL: serverRoot() },
                    source: "LLAMA_BASE_URL",
                }),
            },
        },
        getModels: () => catalog,
        async refreshModels({ allowNetwork, signal, stored, publish }) {
            const restored = (stored?.models ?? []).filter(isChatModel);
            if (restored.length > 0) {
                if (!process.env.LLAMA_BASE_URL?.trim()) {
                    learnedServerUrl = restored[0]?.baseUrl;
                    provider.baseUrl = inferenceUrl();
                }
                await publish({ update: () => (catalog = restored) });
            }
            if (!allowNetwork || signal.aborted) return;
            try {
                const entries = await fetchCatalog(signal);
                if (signal.aborted) return;
                const refreshed = entries.map(toModel).sort((left, right) => left.id.localeCompare(right.id));
                // A 200 with zero usable models is not a catalog: llama-swap does
                // that mid-restart, and a proxy can return a valid-looking empty
                // payload. Persisting it would overwrite the good catalog in
                // models-store.json and leave a later cold start with nothing.
                if (refreshed.length === 0) {
                    if (catalog.length > 0) {
                        console.warn("llama-swap: keeping the previous catalog (empty response)");
                        return;
                    }
                    throw new Error("llama-swap returned no usable models");
                }
                await publish({
                    persist: { models: refreshed, checkedAt: Date.now() },
                    update: () => (catalog = refreshed),
                });
            } catch (error) {
                if (signal.aborted) throw error;
                // Keep a usable list; only a cold start with no server reports.
                if (catalog.length === 0) throw error;
                console.warn(`llama-swap: keeping the previous catalog (${String(error)})`);
            }
        },
        stream: (model, context, options) => stream(model, context, options),
        streamSimple: (model, context, options) => streamSimple(model, context, options),
    };

    pi.registerProvider(provider);
}
