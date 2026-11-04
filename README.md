# home4 — personal dotfiles & machine bootstrap

Declarative personal dotfiles + machine setup, managed by [`mise bootstrap`](https://mise.jdx.dev/bootstrap/) — the repo itself is the global mise config.

## Bootstrap

The repo is **private**, so setup runs over SSH (no curl | bash). The machine
needs an SSH key registered with GitHub before this runs:

```sh
curl -fsSL https://mise.run | MISE_SELF_UPDATE_MINIMUM_RELEASE_AGE=0s sh   # install mise (skip if present)
MISE_AUTO_ENV=true mise bootstrap --adopt git@github.com:williamfligor/home4.git
```

`mise bootstrap --adopt <repo>` (mise ≥ 2026.9.3):

1. clones this repo into `~/.config/mise` so the repo-root `mise.toml` **is** the global mise config (global settings + `conf.d/` bundles + tasks),
2. runs the full bootstrap (dotfiles → tools → repos → post-tools hook).

**Before you run it on an existing machine:** back up / move aside any existing `~/.config/mise` that isn't a clone of this repo (--adopt refuses to touch it).

`install.sh`:

1. installs mise into `~/.local/bin` (if absent),
2. clones this repo into `~/.config/mise` so the repo-root `mise.toml` **is** the global mise config (global settings + `conf.d/` bundles + tasks),
3. runs `MISE_AUTO_ENV=true mise bootstrap --yes` (dotfiles → tools → post-tools hook).

**Before you run it on an existing machine:** back up / move aside any existing `~/.config/mise` that isn't a clone of this repo (install.sh refuses to touch it).

## Layout

Global settings and config-less tools live in `mise.toml`. Anything that pairs a
tool with dotfiles lives in a self-contained bundle under `conf.d/`:

```
mise.toml            global: min_version, [settings], [tools] (config-less tools)
mise.linux.toml      Linux placeholder (empty on purpose — Termux may report os=linux)
.miserc.toml         early-init auto_env (forward-compat)
tasks/               mise file-tasks (pi update; mac helpers ship in their bundle)

conf.d/ai/           pi + agent skills + herdr configs (+ [bootstrap.repos])
conf.d/bat/          bat
conf.d/dotfiles/     ~/.dircolors, ~/.ssh/config, ~/.local/bin
conf.d/git/          delta + difftastic + ~/.gitconfig, ~/.config/git
conf.d/macos/        macOS .apps + .app install task + macOS-only dotfiles (mise.macos.toml)
conf.d/nvim/         neovim
conf.d/termux/       ~/.termux (mise.android.toml)
conf.d/tmux/         tmux
conf.d/yazi/         yazi
conf.d/zellij/       zellij
conf.d/zsh/          zsh + prompt + plugins
```

Each bundle holds its own `mise.toml` plus the files it configures (`dot-…/`
payload dirs). Relative `[dotfiles]` sources and `{{ config_root }}` resolve
inside the bundle, and a bundle can add `mise.<env>.toml` for env-scoped bits
(macOS, Termux). Bundles load before the root config, so every destination is
owned by exactly one place; `mise use`/`mise set` never write to a bundle.

Dotfiles are folder-level symlinks for fully-owned static dirs, `symlink-each` for dirs that hold unmanaged neighbors or runtime writes (nvim, ~/.pi, ~/.local/bin, ~/.agents/skills), and individual links for $HOME-root files and `~/.ssh/config`.

## Daily usage

```sh
mise bootstrap        # converge everything (or: mz)
mzs / mzd / mza       # dotfiles status / diff / apply (mise bootstrap dotfiles …)
mise run update-pi    # run a file-task (tasks/)
mise skills sync      # when tool-attached skills land (packslip)
```

Shell activates mise via `~/.zshenv` → `~/.config/zsh/env.sh` (`mise activate zsh --shims`, `MISE_AUTO_ENV=true`).

## Notes / caveats

- Repo is **private**; never commit credentials. Every machine needs an SSH key registered with GitHub (fresh machine: generate + `ssh-add` / add to GitHub → SSH Keys, then bootstrap). If it ever goes public, the `curl | bash` form works as a fallback.
- No encryption; git only tracks filenames + the executable bit (no `0600` semantics).
- Linux baseline is glibc ≥ 2.39 (Ubuntu 24.04+ / Debian trixie+); yazi's official binaries won't start on older glibc.
- Termux needs `MISE_ENV=android`; Termux may report os=linux, so `mise.linux.toml` stays empty.
- `~/.pi`, `~/.config/nvim/lazy-lock.json` etc. are runtime state — not managed, never linked as whole dirs.
- Mac .app bundles are installed via the `http:` tools in `conf.d/macos/mise.macos.toml` plus `conf.d/macos/tasks/install-macos-apps` after first login.
