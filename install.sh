#!/bin/bash
# vi: ft=bash
set -euo pipefail

# Home4 machine bootstrap. The repo is PRIVATE, so setup uses Git-over-SSH —
# there is no curl | bash. The machine needs an SSH key registered with GitHub
# (Defaults ~/.ssh/id_ed25519) BEFORE this runs.
#
#   1. Install mise:            curl -fsSL https://mise.run | sh
#   2. Adopt + bootstrap:       MISE_AUTO_ENV=true mise bootstrap --adopt $REPO_URL
#
# installation steps (what this script does):
#   1. Installs mise (mise.run installer → ~/.local/bin/mise) if absent.
#   2. Runs `mise bootstrap --adopt <repo>` (mise >= 2026.9.3): mise clones this
#      repo into ~/.config/mise so the repo-root mise.toml IS the GLOBAL config
#      (global settings + conf.d bundles + tasks live there), then bootstraps.
#      `--adopt` refuses a non-git ~/.config/mise and never destroys existing
#      config — no extra safety logic needed.
#
# Never commit credentials — the repo is private, but treat it as public.
#
# Optional arg 1 = repo URL/path to adopt (defaults to the private GitHub repo;
# the Docker smoke test passes the local checkout so it exercises this exact
# script without depending on a pushed remote).

REPO_URL="${1:-git@github.com:williamfligor/home4.git}"

if [[ ! -x "${HOME}/.local/bin/mise" ]]; then
    echo "=== Installing mise ==="
    # Take the newest mise, not the default newest-that-is-24h-old, so a fresh
    # install can satisfy a recent min_version floor.
    curl -fsSL https://mise.run | MISE_SELF_UPDATE_MINIMUM_RELEASE_AGE=0s sh
else
    echo "=== mise already installed at ${HOME}/.local/bin/mise ==="
fi
export PATH="${HOME}/.local/bin:$PATH"

if [[ -d "${HOME}/.config/mise" ]] && [[ ! -d "${HOME}/.config/mise/.git" ]]; then
    echo "ERROR: ~/.config/mise exists and is not a git clone of this repo." >&2
    echo "       Move it aside (e.g. mv ~/.config/mise ~/.config/mise.old) or remove it," >&2
    echo "       then re-run this script. Existing mise config is never destroyed automatically." >&2
    exit 1
fi

echo "=== mise bootstrap --adopt ${REPO_URL} ==="
# auto_env enables the platform env files (mise.linux.toml, ...). Set here AND
# in ~/.config/zsh/env.sh — mise 2026.9.1 doesn't read .miserc.toml yet.
MISE_AUTO_ENV=true mise bootstrap --adopt "${REPO_URL}" --yes

echo ""
echo "Done. Open a new shell (env.sh activates mise via ~/.zshenv)."
# NOTE: backticks must be escaped/single-quoted — inside double quotes bash
# would execute `mise run install-macos-apps` here instead of printing it.
echo 'macOS: run `mise run install-macos-apps` after first login to install .app bundles'
