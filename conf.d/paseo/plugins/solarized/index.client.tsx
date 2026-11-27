import type { PluginClientContext } from "@getpaseo/plugin/client";

import { solarizedDark, solarizedLight } from "./client/themes";

export default function contribute(client: PluginClientContext) {
    client.addTheme(solarizedDark);
    client.addTheme(solarizedLight);
    return () => {};
}
