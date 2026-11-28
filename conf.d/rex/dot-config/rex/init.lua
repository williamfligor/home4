-- >>> rex-agent-resume
-- Starts the rex-agent-resume watcher whenever the server loads this file.
-- Path is expanded, not hardcoded: the dotfiles repo is shared across machines
-- and $HOME differs per host (and the plugin is machine-local anyway).
local rex_agent_resume = vim.fn.expand("~/.local/share/rex-agent-resume/plugin.lua")
if vim.fn.filereadable(rex_agent_resume) == 1 then
  -- pcall: the plugin needs the rex server's `rex` module, so outside rex it
  -- raises. A warning is enough; it must not abort the rest of this file.
  local ok, err = pcall(dofile, rex_agent_resume)
  if not ok then
    vim.notify("rex-agent-resume: " .. tostring(err), vim.log.levels.WARN)
  end
end
-- <<< rex-agent-resume
