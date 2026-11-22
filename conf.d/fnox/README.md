# fnox

fnox is the secret bus. This bundle installs `fnox` and links the global config.

## Contract

- `dot-config/fnox/config.toml` owns secret references only. Values live in the
  1Password `Terminal` vault; the file never contains plaintext credentials.
- The 1Password service-account token is the only bootstrap secret. It lives in
  the OS keychain and is referenced by `[providers.op].token`.
- Three secrets are `env = true` so the zsh hook loads them into interactive
  shells. `OP_SERVICE_ACCOUNT_TOKEN` is `env = false`; only the provider reads
  it.
- `conf.d/zsh/dot-zshrc.d/20-fnox.zsh` activates the shell hook. Remove the
  `env = true` overrides and that file to return to exec-only injection.
- `conf.d/ai/dot-pi/agent/extensions/fnox-redact-bridge.ts` registers the exact
  global values with `@spences10/pi-redact`; required keys live in
  `redact-secrets.json`.

Do not add non-secret endpoints here: they would enter the redaction list and
would disappear whenever the keychain is unavailable.

Setup and daily use: see the root `README.md` § Secrets.
