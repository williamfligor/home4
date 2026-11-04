-- ── Entry point ────────────────────────────────────────────────
-- The leader keys have to exist before anything that maps or groups them, so they
-- are assigned first and unconditionally. Everything else is module loading, in
-- dependency order: options, mappings, autocommands, then the plugin manager.
vim.g.mapleader = " "
vim.g.maplocalleader = " "

for _, module in ipairs({
  "config.options",
  "config.keymaps",
  "config.autocmds",
  "config.lazy",
}) do
  require(module)
end
