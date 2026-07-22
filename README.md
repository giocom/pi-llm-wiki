# pi-llm-wiki

A [Pi](https://pi.dev) extension that brings [nvk/llm-wiki](https://github.com/nvk/llm-wiki)'s
evidence-first workflow to the Pi runtime — built up **one feature at a time** so you can
learn the flow as you go. Each version adds a single capability; the package
stays small and the data stays in your local `~/wiki/` hub.

- 한국어: [README-ko.md](./README-ko.md)
- Reference: [nvk/llm-wiki](https://github.com/nvk/llm-wiki) (commit-pinned)
- Source: <https://github.com/giocom/pi-llm-wiki>

## Status

| Version | Features |
|---|---|
| **v0.6** (current) | Adds `/wiki:add` (ingest + compile in one call) on top of v0.5 |
| v0.5 | `/wiki:search` (LLM-driven web search + auto-ingest) |
| v0.4 | `ingest`, `ls`, `show`, `compile`, `query`, `lint`, `index` + auto-rebuilt `_index.md` |
| v0.3 | Auto-rebuild `raw/articles/_index.md` on ingest/compile |
| v0.2 | `ls`, `show`, `compile`, `query` |
| v0.1 | `ingest` (URL or local file) |

Every version is **read-only by default** except `ingest` and `compile` (which write to your hub).
`lint` and `query` are pure reads.

## What it does

Six slash commands, each paired with an LLM-callable tool:

| Slash | Tool | Purpose | LLM? |
|---|---|---|---|
| `/wiki:ingest <URL\|path>` | `wiki_ingest` | Add a source to `raw/articles/<slug>/source.md` | ❌ (fetches URL if URL) |
| `/wiki:ls` | `wiki_ls` | List all ingested articles (markdown table) | ❌ |
| `/wiki:show <slug>` | `wiki_show` | Display one article's frontmatter + body | ❌ |
| `/wiki:compile` | `wiki_compile` | LLM-summarize raw → `wiki/<slug>/index.md` | ✅ (uses Pi's current model) |
| `/wiki:query <text>` | `wiki_query` | Grep + LLM-synthesized one-paragraph answer | ✅ |
| `/wiki:lint` | `wiki_lint` | 5-check audit (frontmatter, wikilinks, empty, duplicates, tags) | ❌ |
| `/wiki:index` | `wiki_index` | Show or `--rebuild` `wiki/_index.md` | ❌ |
| `/wiki:search <query>` | (slash only) | LLM WebSearch + auto-ingest top N URLs | ✅ (LLM does the search) |
| `/wiki:add <URL\|path>` | `wiki_add` | Ingest + compile in one call (use `--no-compile` to skip the LLM step) | ✅ (compile step only) |

## Install

```bash
pi install git:github.com/giocom/pi-llm-wiki
```

For local development:

```bash
git clone git@github.com:giocom/pi-llm-wiki.git
cd pi-llm-wiki
npm install
npm run build
pi -e ./src/index.ts
```

## Hub resolution

Mirrors llm-wiki's convention exactly so you can use the same hub across
Claude Code, Codex, OpenCode, and Pi:

1. `~/.config/llm-wiki/config.json` → `hub_path` (after `~` expansion)
2. `~/wiki` (fallback)

If neither exists, the extension prints a friendly "No llm-wiki hub found"
message. **No automatic creation** — set up the hub first with `claude`,
`codex`, or manually with `mkdir -p ~/wiki/topics/<your-topic>`.

## Quick start

```bash
# Set up your hub (one time)
mkdir -p ~/wiki
# or: echo '{"hub_path": "~/wiki"}' > ~/.config/llm-wiki/config.json

# Start Pi
pi -e ./src/index.ts

# Ingest some sources
> /wiki:ingest ~/notes/bitcoin-intro.md --tags bitcoin,intro
> /wiki:ingest https://example.com/article --tags web

# List what you have
> /wiki:ls

# Look at one
> /wiki:show 3a64ff1d4ec2

# Summarize into a wiki article (uses Pi's current model)
> /wiki:compile

# Search + synthesize an answer
> /wiki:query "lightning network"

# Audit for issues
> /wiki:lint

# Force-rebuild the wiki index
> /wiki:index --rebuild

# Search the web and auto-ingest (requires Pi's WebSearch tool enabled)
> /wiki:search "llm-wiki" --limit 3
> /wiki:search "lightning network" --limit 5

# Add + compile in one shot (ingest then immediately summarize)
> /wiki:add https://example.com/article --tags web
> /wiki:add ~/notes/bitcoin.md --tags bitcoin
> /wiki:add ~/notes/foo.md --no-compile   # ingest only, compile later
```

## Output formats

### `ls` (markdown table)

```markdown
| slug | title | source | tags | ingested_at |
|------|-------|--------|------|--------------|
| `3a64ff1d4ec2` | bitcoin-intro.md | file | `bitcoin`, `intro` | 2026-07-22 00:46:14 |
```

### `index` (wiki articles, auto-generated after compile)

```markdown
| slug | title | source_slugs | compiled_at |
|------|-------|--------------|-------------|
| `03e4ef1aa42f` | note1.md | `03e4ef1aa42f` | 2026-07-22 01:08:23 |
```

### `lint` (grouped by severity)

```markdown
## lint report

**Files scanned:** 2  |  **Errors:** 0  |  **Warnings:** 1  |  **Info:** 1

### WARNING (1)
| check | path | line | message |
|-------|------|------|---------|
| wikilink | `raw/articles/3238dd749ace/source.md` | 14 | Broken wikilink: [[bitcoin-basics]] |
```

### `query` (LLM-synthesized answer + path:line citations)

```markdown
Bitcoin is a decentralized digital currency using a public ledger
(raw/articles/3a64ff1d4ec2/source.md:13). The Lightning Network is a
Layer 2 solution (raw/articles/3a64ff1d4ec2/source.md:19).
```

## Architecture

```
pi-llm-wiki/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── src/
│   ├── index.ts          # Pi shell — 7 commands, 7 tools
│   ├── ingest.ts         # v0.1: URL/file → raw/articles/<slug>/source.md
│   ├── list.ts           # v0.2: ls, show, parseFrontmatter, raw/wiki indexes
│   ├── compile.ts        # v0.2: raw → LLM → wiki/<slug>/index.md
│   ├── query.ts          # v0.2: grep → LLM synthesis
│   ├── lint.ts           # v0.4: 5 audit checks + report formatter
│   ├── search.ts         # v0.5: indirect search (LLM hint + WebSearch)
│   ├── add.ts            # v0.6: runAdd chains ingest + compile
│   ├── llm.ts            # v0.2: Pi AI wrapper (complete via ctx.model)
│   └── __tests__/        # 76 vitest unit tests
└── dist/                 # tsc build output
```

The shell (`index.ts`) is the only file that touches the Pi API. All other
modules are pure functions and unit-testable in milliseconds.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test            # vitest --run (76 tests)
npm run build       # tsc -p tsconfig.build.json
npm run check       # typecheck + test
```

### Peer dependencies

The extension depends on (does not bundle):

- `@earendil-works/pi-coding-agent` — Pi's extension API
- `@earendil-works/pi-ai` — the LLM transport (for `compile`, `query`)
- `typebox` — JSON schema for tool parameter validation

`@earendil-works/pi-ai` is only required for `compile` and `query`. Other
features (`ingest`, `ls`, `show`, `lint`, `index`) work without it.

## License

MIT
