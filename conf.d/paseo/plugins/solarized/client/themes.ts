import type { PluginClientContext } from "@getpaseo/plugin/client";

/** `addTheme`'s input, taken from the context so client code need not import the root entry. */
type ThemeContribution = Parameters<PluginClientContext["addTheme"]>[0];

/**
 * Ethan Schoonover's Solarized palette, https://ethanschoonover.com/solarized/.
 * base03 to base3 are used as given; steps the palette has no tone for (control, border,
 * surface3, surface4) are blends between neighbouring base tones, so every surface keeps
 * the palette's hue.
 */
const base03 = "#002b36";
const base02 = "#073642";
const base01 = "#586e75";
const base00 = "#657b83";
const base0 = "#839496";
const base1 = "#93a1a1";
const base2 = "#eee8d5";
const base3 = "#fdf6e3";
const blue = "#268bd2";

export const solarizedDark: ThemeContribution = {
    id: "solarized-dark",
    name: "Solarized Dark",
    appearance: "dark",
    colors: {
        background: base03,
        foreground: base0,
        raised: base02,
        control: "#16404b",
        border: "#19424d",
        accent: blue,
        mutedForeground: base00,
        ring: base1,
        sidebar: "#002028",
        surface3: "#1f4751",
        surface4: "#2b4f59",
        foregroundExtraMuted: base01,
    },
};

export const solarizedLight: ThemeContribution = {
    id: "solarized-light",
    name: "Solarized Light",
    appearance: "light",
    colors: {
        background: base3,
        // base01 as body text: base00 on base3 falls just under 4.5:1, and it reads as the
        // palette's emphasised tone.
        foreground: base01,
        raised: "#f6efdc",
        control: base2,
        border: "#e3dfcf",
        // Blue darkened toward base03 so that button labels (background-coloured text on an
        // accent fill) stay readable in the light theme.
        accent: "#1c73ab",
        mutedForeground: base00,
        ring: base01,
        surface3: "#d7d6c8",
        surface4: "#c0c4bb",
        foregroundExtraMuted: base1,
    },
};
