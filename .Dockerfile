# syntax=docker/dockerfile:1
FROM ubuntu:24.04

# Bootstrap dependencies, in one layer; the apt lists are dropped afterwards so
# they do not inflate the image.
RUN apt-get update && apt-get install -y git sudo curl bash zsh python3 python3-pip python3-venv build-essential && rm -rf /var/lib/apt/lists/*

ENV HOME=/root
WORKDIR /root

# Install mise exactly as install.sh does on a fresh machine, then prove it runs.
RUN curl -fsSL https://mise.run | MISE_SELF_UPDATE_MINIMUM_RELEASE_AGE=0s sh && \
    export PATH="$HOME/.local/bin:$PATH" && \
    mise --version | head -1

# Tool-cache layer. The config is copied to /tmp/cfg and loaded through
# MISE_CONFIG_DIR so that ~/.config/mise stays EMPTY for the installer's clone
# below, while conf.d/ still resolves (MISE_GLOBAL_CONFIG_FILE would only read the
# root file). Tools land under MISE_DATA_DIR and survive into the installer stage.
#
# The lockfiles have to ride along: resolving without them picks a different
# backend for the same tool (eza's aqua: instead of the locked asdf:), and the
# later bootstrap then finds the version installed but no executable it can
# resolve — a missing shim with no error.
COPY mise.toml mise.linux.toml mise.lock mise.macos.lock .miserc.toml /tmp/cfg/
COPY conf.d /tmp/cfg/conf.d/
RUN --mount=type=secret,id=github_token \
    --mount=type=cache,target=/root/.cache/mise,sharing=locked \
    export PATH="$HOME/.local/bin:$PATH" && \
    mise trust /tmp/cfg/mise.toml >/dev/null 2>&1 ; \
    GITHUB_TOKEN=$(cat /run/secrets/github_token) MISE_CONFIG_DIR=/tmp/cfg \
        MISE_TRUSTED_CONFIG_PATHS=/tmp/cfg MISE_AUTO_ENV=true mise install --yes

# Run the real installer against this checkout: it clones the repository into
# ~/.config/mise (so the repo's mise.toml becomes the global config, as
# --from-git would) and then runs `mise bootstrap --yes`, which applies dotfiles,
# converges tools, runs the post-tools hook and the final task.
#
# The cached layer above is shared with the image, so it can carry pi state
# (~/.pi/agent) from an earlier install. The fresh bootstrap writes its own copy
# as dotfiles and will not overwrite existing files, so that copy is removed
# first. A real machine cannot hit this: bootstrap applies dotfiles before
# `mise install`, so the paths do not exist yet.
COPY . /tmp/home4/
RUN cd /tmp/home4 && \
    rm -rf /root/.pi && \
    git init -q && \
    git -c user.email=ci@localhost -c user.name=ci add -A && \
    git -c user.email=ci@localhost -c user.name=ci commit -qm "context" && \
    export PATH="$HOME/.local/bin:$PATH" && \
    bash /tmp/home4/install.sh /tmp/home4
