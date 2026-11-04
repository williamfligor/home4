-- ── Options ────────────────────────────────────────────────────
-- Option groups as data; applied by loop so a reader can diff intent rather than
-- line noise. Values are the editor's contract — they are spelled the one way
-- Neovim spells them.

local opt = vim.opt

-- Plain assignments, grouped by intent.
local groups = {
  behaviour = {
    mouse = "a",
    clipboard = "unnamedplus",
    completeopt = { "menuone", "noselect", "noinsert" },
    modeline = true,
    modelines = 15,
  },
  ui = {
    number = true,
    relativenumber = true,
    cursorline = true,
    showcmd = true,
    showmode = false, -- lualine shows the mode
    ruler = true,
    laststatus = 2,
    visualbell = true,
    termguicolors = true,
    background = "light",
    signcolumn = "yes",
    scrolloff = 8,
    sidescrolloff = 8,
  },
  search = {
    incsearch = true,
    hlsearch = true,
    showmatch = true,
    ignorecase = true,
    smartcase = true,
  },
  indentation = {
    tabstop = 4,
    shiftwidth = 4,
    softtabstop = 4,
    expandtab = true,
    smartindent = true,
  },
  persistence = {
    undofile = true,
    backup = true,
    writebackup = true,
    swapfile = true,
  },
  wildmenu = {
    wildmode = { "longest:full", "full" },
    wildmenu = true,
  },
  splits = {
    splitbelow = true,
    splitright = true,
  },
  wrapping = {
    wrap = false,
    linebreak = true,
  },
  performance = {
    updatetime = 250,
    timeoutlen = 300,
    ttimeoutlen = 10,
  },
}

-- Comma-list options that only ever gain an entry.
local appended = {
  shortmess = "c",
  belloff = "ctrlg",
  cinoptions = "l1",
}

-- Options whose value is a path under $HOME, expanded once here.
local storage = {
  undodir = "~/.vim/nundo",
  backupdir = "~/.vim/nbackup",
  directory = "~/.vim/nswap",
  shadafile = "~/.vim/nshada",
}

-- Plugin-facing globals. The Python host path is expanded; the rest are values.
local globals = {
  vim_markdown_folding_disabled = 1,
}

local global_paths = {
  python3_host_prog = "~/pyenvs/py3nvim/bin/python",
}

for _, group in pairs(groups) do
  for name, value in pairs(group) do
    opt[name] = value
  end
end

for name, value in pairs(appended) do
  opt[name]:append(value)
end

for name, path in pairs(storage) do
  opt[name] = vim.fn.expand(path)
end

-- Histories, swaps and backups need somewhere to live before they are written.
for _, path in ipairs({ storage.undodir, storage.backupdir, storage.directory }) do
  local dir = vim.fn.expand(path)
  if vim.fn.isdirectory(dir) == 0 then
    vim.fn.mkdir(dir, "p")
  end
end

for name, value in pairs(globals) do
  vim.g[name] = value
end

for name, path in pairs(global_paths) do
  vim.g[name] = vim.fn.expand(path)
end

vim.g.EditorConfig_exclude_patterns = { "fugitive://.*", "scp://.*" }
