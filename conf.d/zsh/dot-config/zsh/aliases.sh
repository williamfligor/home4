# Colour. Prefer GNU dircolors (LS_COLORS); fall back to BSD LSCOLORS.
if [ -x /usr/bin/dircolors ]; then
    if [ -r ~/.dircolors ]; then
        eval "$(dircolors -b ~/.dircolors)"
    else
        eval "$(dircolors -b)"
    fi
    alias ls='ls --color=auto'
    alias grep='grep --color=auto'
    alias fgrep='fgrep --color=auto'
    alias egrep='egrep --color=auto'
else
    export LSCOLORS=gxBxhxDxfxhxhxhxhxcxcx
fi

# Editors: prefer neovim where it exists, otherwise leave vi/vim as installed.
if command -v nvim > /dev/null 2>&1; then
    alias vi="nvim"
    alias vim="nvim"
fi

# Interactive safety: never clobber a file by accident.
alias mv="mv -i"
alias cp="cp -i"
alias rm="rm -i"

# Listing and shortcuts.
alias l="ls -laFbh"
alias ldf='ls -laFbh | grep "^d" && ls -la | grep "^-" && ls -la | grep "^l"'
alias lg="lazygit"
alias gs="git status"
alias speedtest="wget -O /dev/null http://cachefly.cachefly.net/100mb.test"

# pi: no session, or with the web gate open.
alias pino="pi --no-session"
alias piw="pi --web-on"

# mise dotfiles: one shortcut per subcommand, all under the mz prefix.
alias mz="mise dotfiles"
alias mza="mise dotfiles apply"
alias mzad="mise dotfiles add"
alias mzadd="mise dotfiles add"
alias mzs="mise dotfiles status"
alias mzls="mise dotfiles status"
alias mzd="mise dotfiles diff"
alias mzc="mise dotfiles conflicts"
alias mze="mise dotfiles edit"
alias mzu="mise dotfiles pull"
alias mzsync="mise dotfiles sync"
alias mzun="mise dotfiles unapply"
alias mzt="mise dotfiles track"
alias mzut="mise dotfiles untrack"
alias mzh="mise dotfiles history"
alias mzrb="mise dotfiles rollback"
alias mzsv="mise dotfiles save"
alias mzw="mise dotfiles watch"
alias mzcap="mise dotfiles capture"
alias mzpth="mise dotfiles paths"
alias mzb="mise bootstrap"
