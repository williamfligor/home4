# Rex agent-resume integration

This bundle wires `rex-agent-resume` into an existing Rex setup; it does not
install Rex itself. The setup task requires `rex`, `jq` and `python3`.

Rex stopped exporting `REX_SESSION` to terminal programs. A pane now carries
`REX_BLOCK`, and a block ID stands for the session that holds it, so the
integrations report panes through `REX_BLOCK` alone. The hook the agent calls
still gates on `REX_SESSION`, though, and the terminal API behind it wants a
session ID rather than a block ID. Until the installer adapts, the setup task
repairs the two installed files after running the installer: the hook shim stops
requiring `REX_SESSION`, and `hook.lua` finds the pane's session through
`REX_BLOCK`. The repair is idempotent and fails if those upstream files change
shape, so an update surfaces instead of silently going back to a hook that
records nothing. Either repair is overwritten by the next installer run, which
is why it lives in the task rather than as a hand edit.

`~/.config/rex/init.lua` is installed as a copy, not a symlink. The
`rex-agent-resume` installer rewrites the whole file atomically during install
and when its palette changes, which would replace a symlink. After edits made by
the installer, run `mise dotfiles add --changed` to capture the updated file in
the checkout.

Run `mise run setup:rex-agent-resume` explicitly. The installer changes agent
configuration in other applications as well as Rex; it can be run again to
update that integration.
