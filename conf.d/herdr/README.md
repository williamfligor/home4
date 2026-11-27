# Herdr

This bundle manages the Herdr TUI/core (`herdr`, `herdr-core`/`hc`), the
`herdr-wake` integration, and Herdr configuration. The macOS GUI app (`Herdr.app`)
and its installer live in `conf.d/macos`; the app manages its own updates.

TUI/core releases come from `releases.herdr.dev`: mise reads the release version
and per-platform checksums there. `hc update` delegates to `mise upgrade
herdr-core` so the mise-managed install remains authoritative.

## Config ownership

- `~/.config/herdr-app/keys.json` and `settings.json` are symlinks. Herdr App
  writes them in place, so edits made in the app are reflected in the checkout.
- `themes/` and `layouts/` use `symlink-each`: repository files are linked
  individually, while app-created state can remain alongside them without being
  added to the repository.
- The `space-folders` mod is linked individually rather than linking the whole
  `mods/` directory, where Herdr App can create editor-support files.
- The two files under `~/.config/herdr/` are copies because the TUI rewrites
  them as whole files. Capture edits with `mise dotfiles add --changed`.
- `~/.pi/agent/extensions/herdr-fork.ts` belongs here rather than to the Pi
  bundle, because it only acts inside Herdr or Herdr Core.

## Runtime paths and setup

`herdr-core` re-execs its own path for holders and the boot service. Its
postinstall therefore copies the binary atomically to `~/.local/bin/herdr-core`,
outside mise's versioned install directory; `~/.local/bin/hc` points to that
stable copy. Mise's own `hc` shim remains first on `PATH`.

`herdr-wake` also needs a stable path because it records that path as
`herdr-core`'s shell. Its postinstall only refreshes the symlink. Run
`mise run setup:herdr-wake` explicitly to wire it into the agents and boot
service; the install command changes those other applications' configuration.
Run `herdr-wake uninstall` before uninstalling the tool so `herdr-core` does not
retain a shell path that no longer exists.
