-- ── Autocommands ───────────────────────────────────────────────
-- Each automation is a spec in a list; the groups are created once, cleared, and
-- shared by the entries that belong to them.

local autocmd = vim.api.nvim_create_autocmd
local augroup = vim.api.nvim_create_augroup

local groups = {}
for _, name in ipairs({ "RestoreCursor", "HighlightYank", "TrimWhitespace", "IndentSettings" }) do
  groups[name] = augroup(name, { clear = true })
end

-- Return to the cursor position saved in the buffer's '" mark.
local function restore_cursor()
  local mark = vim.api.nvim_buf_get_mark(0, '"')
  local line_count = vim.api.nvim_buf_line_count(0)
  if mark[1] > 0 and mark[1] <= line_count then
    pcall(vim.api.nvim_win_set_cursor, 0, mark)
  end
end

-- Strip trailing whitespace without moving the view.
local function trim_trailing_whitespace()
  local view = vim.fn.winsaveview()
  pcall(vim.cmd, [[%s/\s\+$//e]])
  vim.fn.winrestview(view)
end

-- Buffer-local indentation for a filetype group.
local function set_indent(buffer, width)
  buffer.tabstop = width
  buffer.shiftwidth = width
end

local specs = {
  {
    event = "BufReadPost",
    group = groups.RestoreCursor,
    callback = restore_cursor,
  },
  {
    event = "TextYankPost",
    group = groups.HighlightYank,
    callback = function()
      vim.highlight.on_yank({ higroup = "IncSearch", timeout = 200 })
    end,
  },
  {
    event = "BufWritePre",
    group = groups.TrimWhitespace,
    pattern = "*",
    callback = trim_trailing_whitespace,
  },
  {
    event = "FileType",
    group = groups.IndentSettings,
    pattern = { "python", "lua", "ruby", "javascript", "typescript" },
    callback = function(args)
      set_indent(vim.bo[args.buf], 4)
    end,
  },
  {
    event = "FileType",
    group = groups.IndentSettings,
    pattern = { "html", "css", "json", "yaml", "markdown", "xml" },
    callback = function(args)
      set_indent(vim.bo[args.buf], 2)
    end,
  },
}

for _, spec in ipairs(specs) do
  autocmd(spec.event, {
    group = spec.group,
    pattern = spec.pattern,
    callback = spec.callback,
  })
end
