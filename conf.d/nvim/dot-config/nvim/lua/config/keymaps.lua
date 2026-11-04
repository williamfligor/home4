-- ── Keymaps ────────────────────────────────────────────────────
-- One table of bindings, applied by loop. Descriptions are part of the surface:
-- which-key and the fzf Maps picker read them.

local map = vim.keymap.set
local silent = { noremap = true, silent = true }

-- Editing defaults that are not part of the leader surface.
map("v", "<", "<gv", silent)
map("v", ">", ">gv", silent)

-- In command mode, `%%` is the current buffer's directory with a trailing slash.
vim.cmd([[cnoremap <expr> %% getcmdtype() == ':' ? expand('%:h').'/' : '%%']])

local bindings = {
  -- Search
  { "n", "<leader>sc", ":noh<CR>", "Clear search highlight" },

  -- Buffers
  { "n", "<leader>bd", ":bdelete<CR>", "Delete buffer" },
  { "n", "<leader>bn", ":bn<CR>", "Next buffer" },
  { "n", "<leader>bp", ":bp<CR>", "Previous buffer" },

  -- Files
  { "n", "<leader>fs", ":w<CR>", "Save file" },
  { "n", "<leader>fS", ":wa<CR>", "Save all files" },
  { "n", "<leader>fed", ":e $MYVIMRC<CR>", "Edit config" },
  { "n", "<leader>feR", ":source $MYVIMRC<CR>", "Reload config" },

  -- Quit
  { "n", "<leader>qq", ":qa<CR>", "Quit all" },
  { "n", "<leader>qQ", ":qa!<CR>", "Force quit all" },
  { "n", "<leader>qs", ":xa<CR>", "Save and quit" },

  -- Toggles
  { "n", "<leader>tn", ":set number! relativenumber!<CR>", "Toggle line numbers" },
  { "n", "<leader>tl", ":set wrap!<CR>", "Toggle line wrap" },

  -- Windows
  { "n", "<leader>w-", ":sp<CR>", "Horizontal split" },
  { "n", "<leader>w/", ":vsp<CR>", "Vertical split" },
  { "n", "<leader>w=", "<C-W>=", "Equalize splits" },
  { "n", "<leader>wd", ":q<CR>", "Close window" },
  { "n", "<leader>wh", "<C-W>h", "Focus left" },
  { "n", "<leader>wj", "<C-W>j", "Focus down" },
  { "n", "<leader>wk", "<C-W>k", "Focus up" },
  { "n", "<leader>wl", "<C-W>l", "Focus right" },
  { "n", "<leader>ws", "<C-W>s", "Split horizontally" },
  { "n", "<leader>wv", "<C-W>v", "Split vertically" },
  { "n", "<leader>ww", "<C-W><C-W>", "Focus next window" },

  -- Location list
  { "n", "<leader>en", ":lnext<CR>", "Next location" },
  { "n", "<leader>ep", ":lprev<CR>", "Previous location" },

  -- Diagnostics
  { "n", "<leader>se", vim.diagnostic.open_float, "Show diagnostic" },
  { "n", "[d", vim.diagnostic.goto_prev, "Previous diagnostic" },
  { "n", "]d", vim.diagnostic.goto_next, "Next diagnostic" },
}

for _, binding in ipairs(bindings) do
  local mode, lhs, rhs, desc = binding[1], binding[2], binding[3], binding[4]
  map(mode, lhs, rhs, { desc = desc })
end
