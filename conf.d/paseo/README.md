# Paseo

This bundle installs the Paseo CLI and, on Linux, the user service that runs
its daemon.

The service is written to
`~/.config/systemd/user/dev.mise.paseo.service` by `mise bootstrap`. It uses
`requires_tools = true`, so a full bootstrap installs `paseo` before starting
the daemon. Paseo keeps its own state, config and credentials under `~/.paseo`;
those files are not managed here.

`paseo` is deliberately not pinned to the current release. The daemon is
restarted by `mise bootstrap services apply` or by `systemctl --user restart
dev.mise.paseo` after an upgrade.

## Solarized themes

`plugins/solarized` is a Paseo plugin that adds Solarized Dark and Solarized
Light to Settings → Appearance. The colors are in `client/themes.ts`.

Nothing links it into `~` and nothing installs it during bootstrap. Paseo owns
its own plugin registry in `~/.paseo`, and **Enable plugins** is a daemon-wide
switch that stays off until it is turned on in Settings → Plugins (`pluginsEnabled`
in `~/.paseo/config.json`). Once that switch is on:

```sh
paseo plugin install ~/.config/mise/conf.d/paseo/plugins/solarized
paseo plugin ls                     # expect: solarized  running
```

A directory install is registered by path, not copied, so edits here reach the
daemon with `paseo plugin reload solarized` and the repo stays the only source.
The plugin source is plain TypeScript in the repo, which means `prettier`
restyles it like everything else; `npm install` inside `plugins/solarized`
installs the dev dependencies used by `npm run typecheck` (Paseo supplies the
runtime, React and Zod when the plugin loads).

Themes need a client that supports plugin themes (0.16 or later), so update the
app before installing on an older machine.
