# Source a zsh plugin installed by mise's `http:` backend, by name:
#
#   mise-plugin <name> [file]
#
# The channel symlinks are probed directly, so shell startup never forks `mise`
# just to ask where a plugin lives.
mise-plugin() {
	emulate -L zsh -o no_aliases
	local name=${1-}
	local want=${2:-${name}.plugin.zsh}
	local root=${HOME}/.local/share/mise/installs/http-${name}
	local channel file
	for channel in latest rel_latest vlatest; do
		file=${root}/${channel}/${want}
		[[ -f $file && -r $file ]] || continue
		source $file
		return $?
	done
	return 0
}
