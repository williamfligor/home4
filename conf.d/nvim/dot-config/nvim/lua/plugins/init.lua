-- ── Plugin specifications ──────────────────────────────────────
-- lazy.nvim owns installation (GitHub → stdpath("data")/lazy); nothing here
-- comes from mise. The key surface, the which-key groups and the LSP wiring are
-- data tables with loops; per-plugin `opts`/`config` payloads are the plugins'
-- own documented examples.

-- Leader prefixes and the noun shown for each in which-key.
local which_key_groups = {
  { "b", "buffer" },
  { "f", "file" },
  { "g", "git" },
  { "p", "project" },
  { "w", "window" },
  { "t", "toggle" },
  { "e", "location" },
  { "q", "quit" },
  { "s", "search" },
  { "d", "docstring" },
  { "m", "doxygen" },
}

local which_key_entries = {}
for _, group in ipairs(which_key_groups) do
  which_key_entries[#which_key_entries + 1] = { "<leader>" .. group[1], group = group[2] }
end

-- fzf-lua pickers: leader suffix, provider, description.
local fzf_pickers = {
  { "?", "keymaps", "Key maps" },
  { "bb", "buffers", "Buffers" },
  { "ff", "files", "Find files" },
  { "pf", "git_files", "Git files" },
  { "fr", "oldfiles", "Recent files" },
  { "gs", "git_status", "Git modified files" },
}

-- Search the register with ripgrep, minus the word-boundary markers rg rejects.
local function rg_from_search_register()
  local search = vim.fn.getreg("/"):gsub("^\\<", ""):gsub("\\>$", "")
  if search ~= "" then
    require("fzf-lua").live_grep({ search = search })
  end
end

local fzf_keys = {}
for _, picker in ipairs(fzf_pickers) do
  local provider = picker[2]
  fzf_keys[#fzf_keys + 1] = {
    "<leader>" .. picker[1],
    function()
      require("fzf-lua")[provider]()
    end,
    desc = picker[3],
  }
end
fzf_keys[#fzf_keys + 1] = { "<leader>s*", rg_from_search_register, desc = "Rg from search register" }
fzf_keys[#fzf_keys + 1] = {
  "<leader>sp",
  function()
    require("fzf-lua").live_grep()
  end,
  desc = "Ripgrep search",
}

-- gitsigns hunk actions, applied buffer-locally on attach.
local hunk_actions = {
  { "]c", "nav_hunk", "Next git hunk", "next" },
  { "[c", "nav_hunk", "Previous git hunk", "prev" },
  { "<leader>gp", "preview_hunk", "Preview git hunk" },
  { "<leader>gr", "reset_hunk", "Reset git hunk" },
  { "<leader>gR", "reset_buffer", "Reset git buffer" },
  { "<leader>ga", "stage_hunk", "Stage git hunk" },
  { "<leader>gA", "stage_buffer", "Stage git buffer" },
}

local function gitsigns_on_attach(bufnr)
  local gs = package.loaded.gitsigns
  for _, action in ipairs(hunk_actions) do
    local lhs, method, desc, arg = action[1], action[2], action[3], action[4]
    local rhs = arg and function()
      gs[method](arg)
    end or gs[method]
    vim.keymap.set("n", lhs, rhs, { buffer = bufnr, desc = desc })
  end
end

-- Enable servers only when their executable exists; custom entries also provide
-- their command and filetypes.
local lsp_servers = {
  { name = "clangd", binary = "clangd" },
  {
    name = "bitbake_language_server",
    binary = "bitbake-language-server",
    config = {
      cmd = { "bitbake-language-server" },
      filetypes = { "bitbake" },
      root_markers = { ".git" },
    },
  },
  {
    name = "tclsp",
    binary = "tclint",
    config = { cmd = { "tclint", "--lsp" }, filetypes = { "tcl" }, root_markers = { ".git" } },
  },
}

local function enable_servers()
  for _, server in ipairs(lsp_servers) do
    if vim.fn.executable(server.binary) == 1 then
      if server.config then
        vim.lsp.config[server.name] = server.config
      end
      vim.lsp.enable(server.name)
    end
  end
end

return {
  -- ── Colorscheme ────────────────────────────────────────────
  {
    "maxmx03/solarized.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      require("solarized").setup({
        theme = "neo",
      })
      vim.cmd.colorscheme("solarized")
    end,
  },

  -- ── Statusline ─────────────────────────────────────────────
  {
    "nvim-lualine/lualine.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    event = "VeryLazy",
    opts = {
      options = {
        theme = "solarized_light",
        section_separators = { left = "", right = "" },
        component_separators = { left = "", right = "" },
      },
    },
  },

  -- ── Which-key ──────────────────────────────────────────────
  {
    "folke/which-key.nvim",
    event = "VeryLazy",
    opts = {
      plugins = { spelling = { enabled = true } },
    },
    config = function(_, opts)
      local wk = require("which-key")
      wk.setup(opts)
      wk.add(which_key_entries)
    end,
  },

  -- ── Fuzzy finder ───────────────────────────────────────────
  -- fzf-lua drives the fzf binary mise already installs (repo-root mise.toml),
  -- so there is no second copy to download and no build step.
  {
    "ibhagwan/fzf-lua",
    lazy = false,
    keys = fzf_keys,
  },

  -- ── Git signs ──────────────────────────────────────────────
  {
    "lewis6991/gitsigns.nvim",
    event = "BufReadPre",
    opts = {
      signs = {
        add = { text = "│" },
        change = { text = "│" },
        delete = { text = "_" },
        topdelete = { text = "‾" },
        changedelete = { text = "~" },
      },
      on_attach = gitsigns_on_attach,
    },
  },

  -- ── Undotree ───────────────────────────────────────────────
  {
    "mbbill/undotree",
    cmd = "UndotreeToggle",
    keys = {
      { "<leader>u", "<cmd>UndotreeToggle<cr>", desc = "Toggle undo tree" },
    },
  },

  -- ── Indent guides ──────────────────────────────────────────
  {
    "lukas-reineke/indent-blankline.nvim",
    event = { "BufReadPost", "BufNewFile" },
    main = "ibl",
    opts = {
      indent = { char = "│" },
      scope = { enabled = true },
    },
  },

  -- ── LSP ────────────────────────────────────────────────────
  {
    "neovim/nvim-lspconfig",
    event = { "BufReadPre", "BufNewFile" },
    config = enable_servers,
  },

  -- ── Completion ─────────────────────────────────────────────
  {
    "saghen/blink.cmp",
    version = "1.*",
    event = "InsertEnter",
    opts = {
      keymap = {
        preset = "enter",
        ["<Tab>"] = { "select_next", "fallback" },
        ["<S-Tab>"] = { "select_prev", "fallback" },
      },
      appearance = {
        nerd_font_variant = "Nerd Font Mono",
      },
      completion = {
        menu = {
          border = nil,
        },
        documentation = {
          auto_show = true,
          window = { border = "single" },
        },
      },
      sources = {
        default = { "lsp", "path", "snippets", "buffer" },
      },
      signature = {
        enabled = true,
        window = {
          border = "single",
          scrollbar = true,
        },
      },
      fuzzy = {
        implementation = "rust",
      },
    },
  },

  -- ── Git fugitive ───────────────────────────────────────────
  {
    "tpope/vim-fugitive",
    cmd = { "Git", "G" },
    keys = {
      { "<leader>gS", "<cmd>Git<cr>", desc = "Git status" },
    },
  },

  -- ── Snacks (dashboard, etc.) ───────────────────────────────
  {
    "folke/snacks.nvim",
    lazy = false,
  },
}
