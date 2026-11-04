#!/bin/bash
set -euo pipefail

# Chatter a zsh login shell prints that would otherwise drown the assertions.
NOISE='bindkey|tput|zle|zsh:'

INTERACTIVE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --shell) INTERACTIVE=1 ;;
        -h | --help)
            echo "Usage: $(basename "$0") [--shell]" >&2
            echo "  --shell  drop into the test container on success" >&2
            exit 0
            ;;
        *)
            echo "Unknown argument: $1 (see --help)" >&2
            exit 2
            ;;
    esac
    shift
done

# podman first (daemonless, rootless), docker second. buildx is used with either,
# because the build mounts a secret and that needs BuildKit.
if command -v podman &>/dev/null; then
    RUNNER=podman
elif command -v docker &>/dev/null; then
    RUNNER=docker
else
    echo "ERROR: Neither podman nor docker found" >&2
    exit 1
fi
echo "Using $RUNNER"

# Docker-only local cache. CI restores it into /tmp/.buildx-cache; podman/buildah
# cannot use type=local. The ${CACHE_ARGS[@]+...} guard exists because bash 3.2
# (macOS stock) treats an empty array expansion as an unbound variable under
# `set -u`.
CACHE_ARGS=()
if [ "$RUNNER" = "docker" ] && [ -d /tmp/.buildx-cache ]; then
    # Quoted so shellcheck does not read the commas in a cache spec as array
    # element separators (SC2054).
    CACHE_ARGS=("--cache-from=type=local,src=/tmp/.buildx-cache" "--cache-to=type=local,dest=/tmp/.buildx-cache,mode=max")
fi

$RUNNER buildx build \
    --load \
    --progress=plain \
    ${CACHE_ARGS[@]+"${CACHE_ARGS[@]}"} \
    --secret "id=github_token,env=GITHUB_TOKEN" \
    -t home4-test -f .Dockerfile .

# The three blocks run inside the image as an interactive zsh session. Each is a
# quoted heredoc so the shell does not expand it here: $HOME, $() and friends are
# evaluated in the container. (The baseline embedded them as single-quoted
# arguments next to a grep -oP pattern that itself contained single quotes;
# heredocs remove that hazard.)
BOOTSTRAP_SCRIPT=$(
    cat <<'ZSH'
fail=0

echo "[0] bootstrap state (idempotent re-run / dry-run)..."
if mise bootstrap dotfiles apply --dry-run >/tmp/dry.log 2>&1; then
    echo "  ✓ dotfiles converged (dry-run: no changes needed)"
else
    echo "  ✗ dotfiles dry-run FAILED (last lines of /tmp/dry.log below)"
    tail -5 /tmp/dry.log | sed "s/^/      /"
    fail=1
fi
if mise bootstrap status >/tmp/status.log 2>&1; then
    echo "  ✓ mise bootstrap status ok"
else
    echo "  ✗ mise bootstrap status FAILED (last lines of /tmp/status.log below)"
    tail -5 /tmp/status.log | sed "s/^/      /"
    fail=1
fi

echo "[1] skills..."
for skill in avoid-ai-writing humanizer uv-package-manager video-to-recipe; do
    if [ -f "$HOME/.agents/skills/$skill/SKILL.md" ]; then echo "  ✓ $skill"; else echo "  ✗ $skill MISSING"; fail=1; fi
done

echo "[2] shell env (env.sh via zshenv)..."
if [ "$MISE_AUTO_ENV" = "true" ]; then
    echo "  ✓ MISE_AUTO_ENV=true exported"
else
    echo "  ✗ MISE_AUTO_ENV not true"
    fail=1
fi
if [ -f "$HOME/.zshrc" ] && [ ! -L "$HOME/.zshrc" ] && cmp -s "$HOME/.config/mise/conf.d/zsh/dot-zshrc" "$HOME/.zshrc"; then
    echo "  ✓ ~/.zshrc is a copy matching its source"
else
    echo "  ✗ ~/.zshrc is not a copy matching its source"
    fail=1
fi

echo "=== bootstrap smoke test complete ==="
exit $fail
ZSH
)

MISE_SCRIPT=$(
    cat <<'ZSH'
fail=0

echo "[1] mise binary..."
if command -v mise &>/dev/null; then
    echo "  ✓ mise $(mise --version 2>&1 | head -1)"
else
    echo "  ✗ mise not found in PATH"
    fail=1
fi

echo "[2] mise tools installed..."
for tool in fd rg eza bat fzf tmux delta; do
    if command -v "$tool" &>/dev/null; then
        echo "  ✓ $tool ($(which "$tool"))"
    else
        echo "  ✗ $tool MISSING"
        fail=1
    fi
done

echo "[3] mise which check..."
if mise which fd 2>/dev/null; then
    echo "  ✓ mise which fd works"
else
    echo "  ✗ mise which fd failed"
    fail=1
fi

echo "=== mise smoke test complete ==="
exit $fail
ZSH
)

NVIM_SCRIPT=$(
    cat <<'ZSH'
fail=0

echo "[1] neovim binary..."
if command -v nvim &>/dev/null; then
    echo "  ✓ nvim $(nvim --version | head -1)"
else
    echo "  ✗ nvim not found"
    fail=1
fi

echo "[2] bootstrap lazy.nvim + install plugins..."
if nvim --headless "+Lazy! sync" +qa >/tmp/lazy-sync.log 2>&1; then
    echo "  ✓ Lazy! sync ok"
else
    echo "  ✗ Lazy! sync FAILED (last lines of /tmp/lazy-sync.log below)"
    fail=1
fi
tail -15 /tmp/lazy-sync.log | sed "s/^/    /"

echo "[3] clean startup check..."
if nvim --headless -c "lua print(\"startup OK\")" -c "quit" >/tmp/nvim-startup.log 2>&1; then
    echo "  ✓ startup OK"
else
    echo "  ✗ startup FAILED (see /tmp/nvim-startup.log below)"
    fail=1
    cat /tmp/nvim-startup.log | sed "s/^/    /"
fi

echo "[4] plugin loadability..."
for plugin in lazy lspconfig blink.cmp sidekick snacks; do
    result=$(nvim --headless -c "lua local ok, e = pcall(require, \"$plugin\"); if ok then print(\"✓ $plugin loaded\") else print(\"✗ \" .. tostring(e):gsub(\"\\n\",\" \")) end" -c "quit" 2>&1 | grep -E "^[✓✗]")
    echo "  $result"
    case "$result" in *"✗"*) fail=1 ;; esac
done

echo "[5] lockfile..."
if [ -f "$HOME/.config/nvim/lazy-lock.json" ]; then
    count=$(grep -oP '^\s*"\K[^"]+' "$HOME/.config/nvim/lazy-lock.json" | sort -u | wc -l)
    echo "  ✓ lazy-lock.json ($count entries)"
else
    echo "  ✗ lazy-lock.json MISSING"
    fail=1
fi

echo "[6] error scan..."
errors=$(grep -E "Error |E[0-9]+:" /tmp/nvim-startup.log 2>/dev/null | grep -iv "blink.cmp" | grep -iv "cargo" || true)
if [ -n "$errors" ]; then
    echo "  ⚠ errors found:"
    echo "$errors" | sed "s/^/    /"
else
    echo "  ✓ no startup errors"
fi

echo ""
echo "=== smoke test complete ==="
exit $fail
ZSH
)

# Run one block and return the container's status. Not the pipeline's: grep
# returns 1 when it filters every line, which is exactly what a clean run looks
# like, so the verdict has to come from PIPESTATUS[0].
smoke() {
    local label=$1 script=$2 rc=0
    echo ""
    echo "=== $label ==="
    $RUNNER run --rm home4-test zsh -ic "$script" 2>&1 | grep -Ev "$NOISE" || rc=${PIPESTATUS[0]}
    return "$rc"
}

# Every block runs even if an earlier one failed, so one run shows every
# section's diagnostics; the failure is reported at the end.
rc_bootstrap=0
smoke "Bootstrap smoke test" "$BOOTSTRAP_SCRIPT" || rc_bootstrap=$?
rc_mise=0
smoke "Mise smoke test" "$MISE_SCRIPT" || rc_mise=$?
rc_nvim=0
smoke "Neovim smoke test (zsh session)" "$NVIM_SCRIPT" || rc_nvim=$?

if [ "$rc_bootstrap" -ne 0 ] || [ "$rc_mise" -ne 0 ] || [ "$rc_nvim" -ne 0 ]; then
    echo ""
    echo "SMOKE TEST FAILED (bootstrap=$rc_bootstrap mise=$rc_mise nvim=$rc_nvim)" >&2
    echo "Debug interactively: $RUNNER run --rm -it -v \"\$PWD:/root/.config/mise\" home4-test" >&2
    exit 1
fi

if [ "$INTERACTIVE" -eq 1 ]; then
    echo ""
    echo "Dropping into interactive container..."
    $RUNNER run \
        --rm \
        -it \
        -v "$(pwd):/root/.config/mise" \
        home4-test
fi
