#!/bin/bash
# vi: ft=bash
set -euo pipefail

# Bootstrap the private repo over SSH; register a GitHub SSH key first.
# Never commit credentials, even though this repository is private.
# Optional arg 1 is the repo URL/path; the smoke test passes the local checkout.

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
# Select the platform config fragments for this bootstrap.
MISE_AUTO_ENV=true mise bootstrap --adopt "${REPO_URL}" --yes

echo ""
echo "Done. Open a new shell (env.sh activates mise via ~/.zshenv)."
# NOTE: backticks must be escaped/single-quoted — inside double quotes bash
# would execute `mise run install-macos-apps` here instead of printing it.
echo 'macOS: run `mise run install-macos-apps` after first login to install .app bundles'
