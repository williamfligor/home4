# Rolling history backup: once an hour at most, and only when the file changed.
#
# Backups: ${XDG_CACHE_HOME:-~/.cache}/zsh-history-backups/zsh_history-<stamp>,
# newest 30 kept. The prompt path stays fork-free — the clock comes from
# zsh/datetime, the mtime from zsh/stat, the name from strftime — so a copy is
# the only thing that ever spawns a process, and only when both gates pass.

zmodload zsh/stat 2>/dev/null
zmodload zsh/datetime 2>/dev/null
autoload -Uz add-zsh-hook

__zsh_history_backup() {
	emulate -L zsh
	local histfile=${HISTFILE:-$HOME/.zsh_history}
	local dir=${XDG_CACHE_HOME:-$HOME/.cache}/zsh-history-backups
	local gate=3600 keep=30

	[[ -s $histfile ]] || return 0

	local now=${EPOCHSECONDS:-$(command date +%s)}
	local stamp=$dir/.last_backup_time
	if [[ -f $stamp ]]; then
		local last
		last=$(<"$stamp")
		(( now - last < gate )) && return 0
	fi

	mkdir -p -- "$dir" 2>/dev/null || return 0

	local hist_mtime=0
	if zmodload -e zsh/stat 2>/dev/null; then
		local -a mt
		if zstat -A mt +mtime -- "$histfile" 2>/dev/null; then
			hist_mtime=$mt[1]
		fi
	fi
	if (( hist_mtime <= 0 )); then
		hist_mtime=$(builtin stat -c %Y -- "$histfile" 2>/dev/null ||
			builtin stat -f %m -- "$histfile" 2>/dev/null || print 0)
	fi
	(( hist_mtime > 0 )) || return 0

	local seen=$dir/.last_backup_mtime
	local previous=0
	[[ -f $seen ]] && previous=$(<"$seen")
	(( hist_mtime > previous )) || return 0

	local name=$dir/zsh_history-$(strftime '%Y%m%d-%H%M%S' $now)
	cp -- "$histfile" "$name" 2>/dev/null || return 0
	print -r -- $hist_mtime >|"$seen"
	print -r -- $now >|"$stamp"

	local -a older
	older=("$dir"/zsh_history-*(Nom))
	(( ${#older} > keep )) && rm -f -- "${(@)older[keep+1,-1]}" 2>/dev/null
	return 0
}

add-zsh-hook precmd __zsh_history_backup
