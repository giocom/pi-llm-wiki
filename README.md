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
| **v0.15** (current) | `/wiki:query --quick/--deep/--list` — depth selector: quick (index-only), list (grep table, no LLM), deep (full grep + LLM) |
| v0.14 | `/wiki:lint --fix` — auto-fix missing frontmatter fields + broken wikilinks → plain text |
| v0.9 | `default_lang` config for compile/merge/query (e.g. respond in Korean) |
| v0.8 | Multi-source compile (`/wiki:merge`), dedup with `--force`, tag filters, auto wiki context injection |
| v0.7 | URL ingest uses `turndown` for proper HTML→Markdown (was naive regex in v0.1–v0.6) |
| v0.6 | `/wiki:add` (ingest + compile in one call) |
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
| `/wiki:ls` | `wiki_ls` | List all ingested articles (markdown table; `--tag <name>` to filter) | ❌ |
| `/wiki:show <slug>` | `wiki_show` | Display one article's frontmatter + body | ❌ |
| `/wiki:compile` | `wiki_compile` | LLM-summarize raw → `wiki/<slug>/index.md` | ✅ (uses Pi's current model) |
| `/wiki:query <text>` | `wiki_query` | Grep + LLM-synthesized answer (`--quick`/`--deep`/`--list`) | ✅ (`--list`: ❌) |
| `/wiki:lint` | `wiki_lint` | 5-check audit (frontmatter, wikilinks, empty, duplicates, tags) + `--fix` auto-repair | ❌ |
| `/wiki:index` | `wiki_index` | Show or `--rebuild` `wiki/_index.md` | ❌ |
| `/wiki:search <query>` | (slash only) | LLM WebSearch + auto-ingest top N URLs | ✅ (LLM does the search) |
| `/wiki:add <URL\|path>` | `wiki_add` | Ingest + compile in one call (use `--no-compile` to skip the LLM step) | ✅ (compile step only) |
| `/wiki:merge --sources a,b` | `wiki_merge` | Combine multiple raw sources into one wiki article (optional `--slug out`) | ✅ |

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

Optional config keys (v0.9):
- `default_lang` — language code (`ko`, `ja`, `en`, ...) used by `/wiki:compile`, `/wiki:merge`, and `/wiki:query` to instruct the LLM to respond in that language. Example: `"default_lang": "ko"`.

If neither exists, the extension prints a friendly "No llm-wiki hub found"
message. **No automatic creation** — set up the hub first with `claude`,
`codex`, or manually with `mkdir -p ~/wiki/topics/<your-topic>`.

## Agent reference

LLM agents (Claude Code, Codex, OpenCode, etc.) operating inside a Pi session
that has this extension installed can read [AGENTS.md](./AGENTS.md) for a
quick reference of the workflow, tools, and core principles. The Korean
version is [AGENTS-ko.md](./AGENTS-ko.md). Llm-wiki's broader portable
protocol (which inspired this extension) lives at
<https://github.com/nvk/llm-wiki/blob/master/AGENTS.md>.

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

# v0.8: dedup with --force
> /wiki:ingest ~/notes/foo.md            # error if slug exists with different content
> /wiki:ingest ~/notes/foo.md --force    # overwrite anyway

# v0.8: tag filters
> /wiki:ls --tag bitcoin
> /wiki:query "wallet" --tag security

# v0.8: merge multiple sources into one wiki article
> /wiki:merge --sources slug1,slug2,slug3
> /wiki:merge --sources slug1,slug2 --slug btc-overview

# v0.14: auto-fix lint issues
> /wiki:lint --fix          # frontmatter field insertion, broken wikilinks → plain text

# v0.15: query depth selector
> /wiki:query "lightning" --quick   # scan only _index.md files (fast)
> /wiki:query "lightning" --list    # grep results as table, no LLM
> /wiki:query "lightning" --deep    # full grep + LLM synthesis (default)
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

### `lint --fix` (auto-repair)

```markdown
## lint report + fix

**Files scanned:** 2  |  **Errors:** 0  |  **Warnings:** 1  |  **Info:** 1

### WARNING (1)
| check | path | line | message |
|-------|------|------|---------|
| wikilink | `wiki/abc123def456/index.md` | 14 | Broken wikilink: [[bitcoin-basics]] |

### /path/to/wiki/abc123def456/index.md
- fixed: Replaced 1 broken wikilink(s) with plain text

**Total fixes applied: 1**
```

### `query --list` (grep table, no LLM)

```markdown
| citation | excerpt |
|----------|---------|
| `wiki/abc123def456/index.md` | 14: The Lightning Network is a Layer 2 ... |
| `raw/articles/xyz789/source.md` | 22: Lightning enables fast payments ... |
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
│   ├── index.ts          # Pi shell — 9 commands, 9 tools, before_agent_start hook
│   ├── ingest.ts         # v0.1: URL/file → raw/articles/<slug>/source.md
│   ├── list.ts           # v0.2: ls, show, parseFrontmatter, raw/wiki indexes
│   ├── compile.ts        # v0.2: raw → LLM → wiki/<slug>/index.md (single + multi-source)
│   ├── query.ts          # v0.2: grep → LLM synthesis
│   ├── lint.ts           # v0.4: 5 audit checks + report formatter
│   ├── fix.ts            # v0.14: auto-fix frontmatter + broken wikilinks
│   ├── search.ts         # v0.5: indirect search (LLM hint + WebSearch)
│   ├── add.ts            # v0.6: runAdd chains ingest + compile
│   ├── context.ts        # v0.8: auto-inject wiki excerpts into system prompt
│   ├── llm.ts            # v0.2: Pi AI wrapper (complete via ctx.model)
│   └── __tests__/        # vitest unit tests
└── dist/                 # tsc build output
```

The shell (`index.ts`) is the only file that touches the Pi API. All other
modules are pure functions and unit-testable in milliseconds.

### Auto wiki context injection (v0.8 + v0.12)

On every agent turn, a `before_agent_start` hook does two optional
injections:

1. **AGENTS.md agent reference (v0.11, gated in v0.12)** — only when
   the user prompt contains a wiki trigger word (`/wiki`, `wiki`,
   `워키`, `워크`, `정리해`, `요약해`, `컴파일`, `만들어`, `ingest`,
   `compile`, `query`, `merge`, `lint`, etc.). Avoids spending ~3-4k
   tokens on unrelated turns. Korean variant (`AGENTS-ko.md`) is
   preferred when `default_lang` is `ko`.
2. **Wiki context (v0.8)** — always attempted (cheap keyword
   extract). Up to 5 keywords are pulled from the prompt, then
   `wiki/` and `raw/articles/` are grepped for matching lines. If
   matches are found, appends a `## Wiki context (auto-injected)`
   block with `path:line` citations. Zero overhead when no
   matches.

This means the LLM can cite the user's own wiki when answering
without the user having to call `/wiki:query` explicitly, and
the LLM has the agent reference (tool table, hub layout, core
principles) in scope on wiki-related turns without the user
having to paste anything. Context usage stays bounded — agent
reference is ~9KB (only injected on trigger), wiki context is
~500 tokens worst case.

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

### Bundled runtime dependencies

- `turndown` — HTML → Markdown converter, used by URL ingest in v0.7+
  for proper output (preserves headings, bold, lists, links, code blocks).
  Falls back to a naive regex stripper for SPA shells or malformed HTML.

## License

MIT
