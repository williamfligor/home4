# Yazi: open it here, come back where you left it. yazi writes its exit
# directory to a temp file, so a session behaves like `cd` instead of a detour.
function y() {
	local cwd_file cwd
	cwd_file=$(mktemp -t yazi-cwd.XXXXXX) || return 1
	command yazi "$@" --cwd-file="$cwd_file"
	# yazi writes the path without a trailing newline: read the whole file.
	cwd=$(<"$cwd_file")
	rm -f -- "$cwd_file"
	[[ -n $cwd && $cwd != $PWD ]] && builtin cd -- "$cwd"
	return 0
}

# Fuzzy-pick ripgrep hits across the repo: Enter prints the selected *files*
# (sorted, unique), Tab accumulates them while the preview follows the cursor.
fzzy() {
	local -a opts
	opts=(
		--multi --ansi --query "${*:-}"
		--bind "start:reload:rg --line-number --no-heading --color always {q}"
		--color "hl:-1:underline,hl+:-1:underline:reverse"
		--prompt 'notes-selector:fzf> '
		--delimiter :
		--preview 'bat --color=always {1} --highlight-line {2}'
		--preview-window 'up,60%,border-bottom,+{2}+3/3,~3'
		--bind 'enter:become:sort -u {+f1}'
		--bind 'tab:toggle+change-preview-window(~0:+1)+change-preview:echo "SELECTED FILES:"; sort -u {+f1} | sed "s/^/  - /"'
		--bind 'focus:+change-preview-window(+{2}+3/3)+change-preview:bat --color=always {1} --highlight-line {2}'
	)
	fzf "${opts[@]}"
}
