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
  { "r", "review" },
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

-- gitsigns hunk actions, applied buffer-locally on attach. Staging, resetting
-- and discarding happen in lazygit or the CLI, so only moving between hunks and
-- looking at one are bound here.
local hunk_actions = {
  { "]c", "nav_hunk", "Next git hunk", "next" },
  { "[c", "nav_hunk", "Previous git hunk", "prev" },
  { "<leader>gp", "preview_hunk", "Preview git hunk" },
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

  -- ── Snacks (lazygit, etc.) ────────────────────────────────
  -- Git is the CLI and lazygit, so lazygit is all snacks is asked for here: its
  -- module themes lazygit to this colorscheme and sends edits back to this nvim
  -- instance instead of opening a second editor.
  {
    "folke/snacks.nvim",
    lazy = false,
    keys = {
      {
        "<leader>gg",
        function()
          require("snacks").lazygit()
        end,
        desc = "Lazygit",
      },
    },
    opts = {
      lazygit = {},
    },
  },

  -- ── Code review ────────────────────────────────────────────
  -- Comments on a codediff.nvim diff, or on any line with :Review note, kept per
  -- repository and exported as markdown for an agent. VeryLazy (not cmd) is what
  -- keeps notes visible as soon as a file opens.
  --
  -- Both plugins default to dark-theme colors, so the tints below are solarized
  -- accents laid over base3 (the background set in config/options.lua). codediff
  -- reads DiffAdd/DiffDelete and solarized supplies those as bare foregrounds —
  -- DiffDelete reversed — which leaves codediff on its dark fallbacks: a
  -- saturated red block and navy insertions. Comment lines get the same
  -- treatment; review.nvim ships near-black backgrounds for them.
  {
    "georgeguimaraes/review.nvim",
    version = "*",
    dependencies = {
      {
        "esmuellert/codediff.nvim", -- fetches its diff library with curl on first use
        opts = {
          diff = { layout = "inline" },
          highlights = {
            line_insert = "#d3e5d4", -- cyan at 20%
            line_delete = "#f7d3c3", -- red at 18%
            line_move = "#f1e5bf", -- yellow at 16%, drawn only with compute_moves
          },
        },
      },
      "MunifTanjim/nui.nvim",
    },
    event = "VeryLazy",
    keys = {
      { "<leader>rr", "<cmd>Review<cr>", desc = "Review working tree" },
      { "<leader>rc", "<cmd>Review commits<cr>", desc = "Review commits" },
      { "<leader>rb", "<cmd>Review branch<cr>", desc = "Review branch" },
      { "<leader>rn", ":Review note<cr>", mode = { "n", "v" }, desc = "Review: note" },
      { "<leader>re", "<cmd>Review edit<cr>", desc = "Review: edit comment" },
      { "<leader>rd", "<cmd>Review delete<cr>", desc = "Review: delete comment" },
      { "<leader>rx", "<cmd>Review export<cr>", desc = "Review: export" },
    },
    config = function(_, opts)
      require("review").setup(opts)
      -- blue, cyan, orange, violet: the accent behind each comment type.
      for group, bg in pairs({
        ReviewNoteLine = "#dfe7e1",
        ReviewSuggestionLine = "#dfead8",
        ReviewIssueLine = "#f4d7be",
        ReviewPraiseLine = "#ece6df",
      }) do
        vim.api.nvim_set_hl(0, group, { bg = bg })
      end
    end,
    opts = {
      keymaps = { send_sidekick = false },
      export = {
        -- The clipboard goes out by OSC 52 (see config/options.lua); the file is
        -- the durable copy an agent can read without a paste.
        on_export = function(markdown)
          local dir = vim.fs.joinpath(vim.fn.stdpath("data"), "review")
          vim.fn.mkdir(dir, "p")
          local path = vim.fs.joinpath(dir, "last-export.md")
          vim.fn.writefile(vim.split(markdown, "\n"), path)
          vim.notify(path, vim.log.levels.INFO, { title = "Review written to" })
        end,
      },
    },
  },
}
