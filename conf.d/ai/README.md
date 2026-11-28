# AI

This bundle installs the Pi coding agent and its configuration: extensions
under `dot-pi/agent/extensions/`, the model overrides in
`dot-pi/agent/models.json`, and the agent skills in `dot-agents/skills/`.

## The llama-swap provider

`extensions/llama-swap.ts` registers llama-swap as a Pi provider (`llama-cpp`)
and publishes its whole catalog, so every model llama-swap can start is
selectable instead of only the loaded one. The endpoint is machine-local and
never named in this repo:

| where | what | tracked |
|---|---|---|
| `LLAMA_BASE_URL` (`conf.d/ai/mise.local.toml`) | the normal source, exported by mise into every shell | no — `*.local.toml` is git-ignored |
| `~/.pi/agent/models-store.json` | what Pi persisted last time — every model carries the `baseUrl` it was registered with | no — Pi state |
| `http://127.0.0.1:9931` | the default when neither of the above exists | — |

Resolution is `LLAMA_BASE_URL` → the persisted catalog → localhost. The middle
step exists because not every Pi session has a shell behind it: the paseo and
herdr daemons are started by systemd with a fixed `Environment=` list, so a
session opened from a phone has no `LLAMA_BASE_URL`. Before that fallback
existed, such a session dialled `127.0.0.1:9931`, where nothing listens, and
died on the first request with:

```
Connection error.: connect ECONNREFUSED 127.0.0.1:9931
```

## New machine

A clone carries neither `mise.local.toml` nor `models-store.json`, so a fresh
machine has no endpoint until both exist. One pass, from a normal terminal:

```bash
# 1. the endpoint; machine-local, so it has to be recreated per host
mkdir -p ~/.config/mise/conf.d/ai
printf '[env]\nLLAMA_BASE_URL = "https://<llama-swap host>"\n' > ~/.config/mise/conf.d/ai/mise.local.toml

# 2. confirm mise exports it from any directory, not just this repo
mise env | grep LLAMA_BASE_URL

# 3. one Pi run (interactive or one-shot) with the llama-cpp provider, online
pi
```

Step 3 is the one that is easy to skip: `refreshModels` fetches `/v1/models`
through the env-derived URL and persists each model's `baseUrl` into
`models-store.json`. Until that has happened once, daemon-launched sessions —
the phone, anything started by paseo or herdr — still fall back to localhost.

If the host later moves, any mise-shell Pi run refreshes the persisted value
(the env wins); daemon sessions pick it up on their next start. A machine that
only ever runs daemon sessions will not, which is the case for a systemd
drop-in with `Environment="LLAMA_BASE_URL=…"` on the paseo and herdr-core
units — not used here, since the file plus one interactive run covers it.
