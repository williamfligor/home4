# Locale and colour. Exported, because this file is read by every zsh — scripts
# and SSH remote commands included — not just interactive ones.
export CLICOLOR=1
export LC_CTYPE=$LANG
export GREP_COLOR='1;32'

# zle: how long ESC waits for the rest of a sequence, in hundredths of a second.
export KEYTIMEOUT=1

# gopass/ncurses want GPG_TTY. `tty` writes "not a tty" to stdout when stdin is
# not a terminal, so only capture it when there is one to report.
if [[ -t 0 ]]; then
  export GPG_TTY="$(tty)"
fi

# User-installed binaries go ahead of everything already on PATH.
export PATH="$HOME/.local/bin:$PATH"

# mise owns the rest of PATH; --shims keeps activation to a single eval line.
eval "$(mise activate zsh --shims)"

# mise 2026.9.1 does not read .miserc.toml, so the per-OS env files are switched
# on here instead (install.sh sets the same variable).
export MISE_AUTO_ENV=true

# Prefer neovim when it is installed; the two variables always agree.
if command -v nvim >/dev/null 2>&1; then
  export EDITOR="nvim" VISUAL="nvim"
else
  export EDITOR="vim" VISUAL="vim"
fi

# zsh-you-should-use draws its hint underneath the command line.
export YSU_MESSAGE_POSITION="after"
