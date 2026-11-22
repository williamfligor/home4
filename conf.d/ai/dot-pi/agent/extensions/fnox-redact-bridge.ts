/**
 * Register global fnox secrets with @spences10/pi-redact.
 * Contract: conf.d/fnox/README.md. Fail closed if the set cannot load.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const STATE_KEY = "__pi_fnox_redact_bridge";
const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_FAILURES = 5;

type RedactConfig = {
    requiredKeys: string[];
    minSecretLength: number;
};

type BridgeState = {
    ready: boolean;
    count: number;
    error?: string;
    loading: boolean;
    failures: number;
    nextRetryAt: number;
};

function state(): BridgeState {
    const shared = globalThis as Record<string, unknown>;
    if (!shared[STATE_KEY]) {
        shared[STATE_KEY] = {
            ready: false,
            count: 0,
            loading: false,
            failures: 0,
            nextRetryAt: 0,
        };
    }
    return shared[STATE_KEY] as BridgeState;
}

function retryDelay(failures: number): number {
    return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.max(0, failures - 1));
}

function configPath(): string {
    if (process.env.PI_FNOX_REDACT_CONFIG) {
        return process.env.PI_FNOX_REDACT_CONFIG;
    }
    return join(getAgentDir(), "redact-secrets.json");
}

function fnoxConfigPath(): string {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    const dir = process.env.FNOX_CONFIG_DIR ?? join(configHome, "fnox");
    return join(dir, "config.toml");
}

async function loadConfig(): Promise<RedactConfig> {
    const path = configPath();
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<RedactConfig>;

    if (
        !Array.isArray(raw.requiredKeys) ||
        raw.requiredKeys.length === 0 ||
        !raw.requiredKeys.every((key): key is string => typeof key === "string" && key.length > 0)
    ) {
        throw new Error(`${path}: requiredKeys must be a non-empty array of strings`);
    }
    if (
        typeof raw.minSecretLength !== "number" ||
        !Number.isInteger(raw.minSecretLength) ||
        raw.minSecretLength < 1
    ) {
        throw new Error(`${path}: minSecretLength must be a positive integer`);
    }

    return {
        requiredKeys: [...new Set(raw.requiredKeys)],
        minSecretLength: raw.minSecretLength,
    };
}

async function loadSecrets(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    if (state().loading) return;
    Object.assign(state(), { loading: true, error: undefined });

    try {
        const hasRedactor = pi.getCommands().some((command) => command.name === "redact-stats");
        if (!hasRedactor) {
            throw new Error("@spences10/pi-redact is not loaded");
        }

        const config = await loadConfig();
        const { stdout } = await execFileAsync(
            "fnox",
            ["-c", fnoxConfigPath(), "export", "--format", "json", "--all", "--non-interactive"],
            {
                encoding: "utf8",
                timeout: 30_000,
                maxBuffer: 4 * 1024 * 1024,
            },
        );
        const parsed = JSON.parse(stdout) as {
            secrets?: Record<string, unknown>;
        };
        const secrets = parsed.secrets ?? {};

        const missing = config.requiredKeys.filter((key) => {
            const value = secrets[key];
            return typeof value !== "string" || value.length < config.minSecretLength;
        });
        if (missing.length > 0) {
            throw new Error(`fnox is missing required secret(s): ${missing.join(", ")}`);
        }

        const values = Object.values(secrets).filter(
            (value): value is string => typeof value === "string" && value.length >= config.minSecretLength,
        );

        pi.events.emit("pi-redact:register-secrets", { values });
        Object.assign(state(), {
            ready: true,
            count: values.length,
            error: undefined,
            loading: false,
            failures: 0,
            nextRetryAt: 0,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failures = state().failures + 1;
        Object.assign(state(), {
            ready: false,
            count: 0,
            error: message,
            loading: false,
            failures,
            nextRetryAt:
                failures >= MAX_FAILURES ? Number.POSITIVE_INFINITY : Date.now() + retryDelay(failures),
        });
        console.error(`[fnox-redact-bridge] ${message}`);
        if (ctx.hasUI) {
            ctx.ui.notify(`Secret redaction unavailable: ${message}`, "error");
        }
    }
}

export default function fnoxRedactBridge(pi: ExtensionAPI): void {
    pi.on("session_start", async (_event, ctx) => {
        await loadSecrets(pi, ctx);
    });

    pi.on("session_shutdown", () => {
        Object.assign(state(), {
            ready: false,
            count: 0,
            error: undefined,
            loading: false,
            failures: 0,
            nextRetryAt: 0,
        });
    });

    pi.on("tool_call", async (_event, ctx) => {
        let current = state();
        if (current.ready) return;

        if (!current.loading && current.failures < MAX_FAILURES && Date.now() >= current.nextRetryAt) {
            await loadSecrets(pi, ctx);
            current = state();
            if (current.ready) return;
        }

        const exhausted = current.failures >= MAX_FAILURES;
        return {
            block: true,
            reason: current.error
                ? `Secret redaction is unavailable: ${current.error}. ${
                      exhausted
                          ? "Retry limit reached; fix fnox/keychain, then restart Pi."
                          : "Fix fnox/keychain before using tools."
                  }`
                : "Secret redaction is still loading. Retry in a moment.",
        };
    });
}
