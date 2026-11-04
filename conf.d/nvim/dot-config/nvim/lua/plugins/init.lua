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
  { "a", "sidekick" },
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

-- fzf.vim pickers: leader suffix, command, description.
local fzf_pickers = {
  { "?", "Maps", "Key maps" },
  { "bb", "Buffers", "Buffers" },
  { "ff", "Files", "Find files" },
  { "pf", "GFiles", "Git files" },
  { "fr", "History", "Recent files" },
  { "gs", "GFiles?", "Git modified files" },
}

-- Search the register with ripgrep, minus the word-boundary markers rg rejects.
local function rg_from_search_register()
  local search = vim.fn.getreg("/"):gsub("^\\<", ""):gsub("\\>$", "")
  if search ~= "" then
    vim.cmd("Rg " .. search)
  end
end

local fzf_keys = {}
for _, picker in ipairs(fzf_pickers) do
  fzf_keys[#fzf_keys + 1] = {
    "<leader>" .. picker[1],
    ("<cmd>%s<CR>"):format(picker[2]),
    desc = picker[3],
  }
end
fzf_keys[#fzf_keys + 1] = { "<leader>s*", rg_from_search_register, desc = "Rg from search register" }
fzf_keys[#fzf_keys + 1] = { "<leader>sp", "<cmd>Rg<SPACE>", desc = "Ripgrep search" }

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

-- Language servers: enable when the binary exists; the two custom entries also
-- register their command and filetypes. The Python server went away with its
-- wrapper, so no branch guards it any more.
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

-- sidekick CLI bindings; the module is required inside the callback so a key press
-- on an unloaded plugin cannot throw at declaration time.
local function sidekick(method, arg)
  return function()
    require("sidekick.cli")[method](arg)
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
  {
    "junegunn/fzf",
    build = ":call fzf#install()",
    lazy = false,
  },
  {
    "junegunn/fzf.vim",
    lazy = false,
    dependencies = { "junegunn/fzf" },
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

  -- ── Commenting ─────────────────────────────────────────────
  {
    "numToStr/Comment.nvim",
    event = { "BufReadPost", "BufNewFile" },
    opts = {},
  },

  -- ── Undotree ───────────────────────────────────────────────
  {
    "mbbill/undotree",
    cmd = "UndotreeToggle",
    keys = {
      { "<leader>au", "<cmd>UndotreeToggle<cr>", desc = "Toggle undo tree" },
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

  -- ── EditorConfig ───────────────────────────────────────────
  {
    "gpanders/editorconfig.nvim",
    event = "VeryLazy",
  },

  -- ── Git fugitive ───────────────────────────────────────────
  {
    "tpope/vim-fugitive",
    cmd = { "Git", "G" },
    keys = {
      { "<leader>gS", "<cmd>Git<cr>", desc = "Git status" },
    },
  },

  -- ── Sidekick (AI assistant) ────────────────────────────────
  {
    "folke/sidekick.nvim",
    lazy = false,
    config = function()
      require("sidekick").setup({
        nes = { enabled = false },
        cli = {
          mux = {
            backend = "zellij",
            enabled = false,
          },
        },
      })
    end,
    keys = {
      { "<C-.>", sidekick("focus"), mode = { "n", "t", "i", "x" }, desc = "Sidekick focus" },
      { "<leader>aa", sidekick("toggle", { name = "pi" }), desc = "Sidekick toggle" },
      { "<leader>an", sidekick("new", { name = "pi" }), desc = "Sidekick new CLI" },
      { "<leader>as", sidekick("select"), desc = "Sidekick select CLI" },
      { "<leader>ad", sidekick("close"), desc = "Sidekick detach" },
      { "<leader>at", sidekick("send", { msg = "{this}" }), mode = { "n", "x" }, desc = "Sidekick send this" },
      { "<leader>af", sidekick("send", { msg = "{file}" }), desc = "Sidekick send file" },
      { "<leader>av", ":Sidekick cli send<CR>", mode = "x", desc = "Sidekick send selection" },
      { "<leader>ap", sidekick("prompt"), mode = { "n", "x" }, desc = "Sidekick prompt" },
    },
  },

  -- ── Snacks (dashboard, etc.) ───────────────────────────────
  {
    "folke/snacks.nvim",
    lazy = false,
  },
}
