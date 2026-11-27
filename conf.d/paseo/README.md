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
