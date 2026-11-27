# Agent Instructions

**Smoke tests are opt-in.** `bash .test.sh` runs only when a person explicitly asks
for a test run — never as a precaution. When asked, say up front that the script
needs Docker or Podman with the `buildx` plugin and BuildKit available; where that
is missing (no buildx, no root to install it, a sandbox that cannot supply them),
report the limitation instead of substituting a workaround.

**Every commit passes the checks first.** The gate is `mise run check`
(`prek run --all-files`). Hooks rewrite files in place — prettier,
end-of-file-fixer, trailing-whitespace, mixed-line-ending — so the loop is: run
the checks, re-stage whatever they rewrote, run them again, and only commit once
they exit clean. `git commit --no-verify` is never the answer; a hook that refuses
to pass is a finding to report, not a step to skip.

**App-owned files are listed in `.prettierignore`.** Pi's `settings.json`,
`auth.json` and pi-blackhole config, herdr-app's `settings.json`, `keys.json` and
`layouts/`, and mise's generated locks are written by their applications or by mise;
do not reformat them by hand. That file is the only place formatter exclusions
belong, and `prek.toml` keeps exclusions only for the byte-level hooks (pi writes no
trailing newline). `mise*.toml` is likewise skipped by `check-toml`, because mise
accepts TOML 1.1 multiline inline tables that a 1.0 parser rejects.

**Content is authored here, never copied.** No text is taken from another
dotfiles repository; every file in this repo was written for it.
