/**
 * Slash-guard: stop a mistyped slash command from being sent to the model.
 *
 * pi's TUI consumes its own built-in commands (/model, /sandbox, …) before an
 * extension sees the input, so everything that reaches this handler is either a
 * registered command (skill, template, extension command), a path, or a typo.
 * The guard answers that question with an ordered list of rules and one decision
 * function; the blocking path notifies the user exactly once.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GuardAction = "continue" | "handled";

type CommandNames = () => readonly { name: string }[];

/** Leading token after the slash, lowercased, or "" when there is none. */
function slashWord(text: string): string {
    const [firstToken = ""] = text.split(/[\s\n]/);
    return firstToken.slice(1).toLowerCase();
}

/** `/etc/hosts`, `/usr/local/bin`: a second slash after the leading one. */
function isPathLike(text: string): boolean {
    return text.indexOf("/", 1) !== -1;
}

/**
 * Decide whether the text may reach the model.
 *
 * Order matters: paths win over command names (so a registered `model` does not
 * make `/model/extra` a command), and an unknown bare word blocks.
 */
export function decide(text: string, commands: CommandNames): GuardAction {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || trimmed === "/") return "continue";
    if (isPathLike(trimmed)) return "continue";

    const word = slashWord(trimmed);
    if (word === "") return "continue";

    const known = commands().some((command) => command.name.toLowerCase() === word);
    return known ? "continue" : "handled";
}

export const UNKNOWN_SLASH_MESSAGE = "Unknown input starting with / — not sent to the model";

export default function (pi: ExtensionAPI): void {
    pi.on("input", async (event, ctx) => {
        // Extension-injected input is never policed: other extensions talk to the
        // model through this path.
        if (event.source === "extension") return { action: "continue" satisfies GuardAction };
        if (decide(event.text, () => pi.getCommands()) === "continue") {
            return { action: "continue" satisfies GuardAction };
        }
        ctx.ui.notify(UNKNOWN_SLASH_MESSAGE, "warning");
        return { action: "handled" satisfies GuardAction };
    });
}
