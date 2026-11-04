/**
 * Keeps the "packages" array of ~/.pi/agent/settings.json alphabetical, so that
 * adding a package is a one-line diff rather than a re-ordered block. Runs once
 * per session start and says nothing unless it actually rewrote the file.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SETTINGS_FILE = join(getAgentDir(), "settings.json");

type Settings = Record<string, unknown>;

/**
 * One string per entry, so the comparator is total: mixed arrays of strings and
 * objects then sort deterministically instead of leaving the objects in place.
 * A string sorts by itself (npm names, @local paths); an object sorts by its
 * "source" when that is a string, and otherwise by its JSON text.
 */
function sortKey(entry: unknown): string {
    if (typeof entry === "string") return entry;
    if (entry === null || typeof entry !== "object") return "";
    const { source } = entry as { source?: unknown };
    return typeof source === "string" ? source : JSON.stringify(entry);
}

function sortedCopy(packages: unknown[]): unknown[] {
    // Array.prototype.sort is stable, so equal keys (and duplicates) keep their
    // relative order.
    return [...packages].sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
}

function sameOrder(left: unknown[], right: unknown[]): boolean {
    return left.every((entry, index) => entry === right[index]);
}

async function load(): Promise<Settings> {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf-8")) as Settings;
}

async function save(settings: Settings): Promise<void> {
    await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        let settings: Settings;
        try {
            settings = await load();
        } catch {
            // Absent, hand-broken, or locked by another pi process: there is
            // nothing to sort, and none of those deserves a startup warning.
            return;
        }

        const packages = settings.packages;
        if (!Array.isArray(packages) || packages.length === 0) return;

        const sorted = sortedCopy(packages);
        if (sameOrder(sorted, packages)) return;

        settings.packages = sorted;
        try {
            await save(settings);
        } catch (error) {
            // The sort visibly did not happen; without this the user would only
            // notice a later session re-sorting the same entries.
            const reason = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`sort-packages: could not write settings.json: ${reason}`, "warning");
            return;
        }
        ctx.ui.notify(`Sorted ${sorted.length} packages in settings.json`, "info");
    });
}
