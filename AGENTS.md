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

**Two JSON files belong to their applications.** They are written by the apps
themselves and deliberately kept out of restyling:
`conf.d/ai/dot-pi/agent/settings.json` and
`conf.d/ai/dot-pi/agent/pi-blackhole/pi-blackhole-config.json`. Do not reformat
them by hand. `mise*.toml` is likewise skipped by `check-toml`, because mise
accepts TOML 1.1 multiline inline tables that a 1.0 parser rejects.

**Content is authored here, never copied.** No text is taken from another
dotfiles repository; every file in this repo was written for it.
