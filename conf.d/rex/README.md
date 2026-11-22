# Rex agent-resume integration

This bundle wires `rex-agent-resume` into an existing Rex setup; it does not
install Rex itself. The setup task requires `rex` and `jq`.

`~/.config/rex/init.lua` is installed as a copy, not a symlink. The
`rex-agent-resume` installer rewrites the whole file atomically during install
and when its palette changes, which would replace a symlink. After edits made by
the installer, run `mise dotfiles add --changed` to capture the updated file in
the checkout.

Run `mise run setup:rex-agent-resume` explicitly. The installer changes agent
configuration in other applications as well as Rex; it can be run again to
update that integration.
