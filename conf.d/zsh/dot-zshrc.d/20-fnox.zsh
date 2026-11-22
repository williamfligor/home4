# fnox shell integration. Contract: conf.d/fnox/README.md.
if (( $+commands[fnox] )); then
	if _fnox_activation=$(fnox activate zsh); then
		eval "$_fnox_activation"
	else
		print -u2 'fnox activate failed; secrets are not loaded'
	fi
	unset _fnox_activation
fi
