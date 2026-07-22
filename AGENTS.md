# pi-llm-wiki — Agent Instructions

> You have the [pi-llm-wiki](https://github.com/giocom/pi-llm-wiki) v0.9
> Pi extension installed. This file is the quick reference for using it.
> Source: <https://github.com/giocom/pi-llm-wiki/blob/master/AGENTS.md>

## What this is

`pi-llm-wiki` is a **local knowledge-base** for Pi. You (the LLM agent) ingest
raw sources (URLs or files), compile them into wiki articles via the current
Pi model, and search the result. The hub is a plain directory of markdown
files under the user's home — no database, no server.

**The metaphor**: raw sources are source code, you are the compiler, the
wiki is the executable.

## Hub layout

Default: `~/wiki/` (configurable via `~/.config/llm-wiki/config.json`).

```
~/wiki/
├── raw/articles/<slug>/source.md     # immutable original (one file per ingest)
├── wiki/<slug>/index.md              # LLM-compiled article (one per raw)
├── raw/articles/_index.md            # auto-regenerated after ingest/compile
└── wiki/_index.md                    # auto-regenerated after compile
```

**Slug** = first 12 hex chars of `sha1(normalized URL)` or `sha1(absolute file path)`.

**Config** (`~/.config/llm-wiki/config.json`):
```json
{
  "hub_path": "~",          // parent of raw/ and wiki/ subdirs
  "default_lang": "ko"      // optional: "ko", "ja", "en", "zh" — sets LLM response language
}
```

## Tools available to you

The extension registers these tools (use them as `wiki_<name>` tool calls):

| Tool | What it does |
|---|---|
| `wiki_ingest` | Add a URL or local file → `raw/articles/<slug>/source.md` |
| `wiki_ls` | List all ingested articles as a markdown table; `tag` filter |
| `wiki_show` | Display one article's frontmatter + body by slug |
| `wiki_compile` | LLM-summarize a raw into `wiki/<slug>/index.md` |
| `wiki_query` | Grep + LLM-synthesized answer with `path:line` citations |
| `wiki_lint` | 5-check audit (frontmatter, wikilinks, empty, duplicates, tags) |
| `wiki_index` | Show or rebuild `wiki/_index.md` |
| `wiki_search` | (slash only) LLM-driven web search + auto-ingest |
| `wiki_add` | Ingest + compile in one call |
| `wiki_merge` | Combine multiple raws into one wiki article |

**Slash commands** (for the user or you to call directly):
- `/wiki:ingest`, `/wiki:ls`, `/wiki:show`, `/wiki:compile`, `/wiki:query`, `/wiki:lint`, `/wiki:index`, `/wiki:search`, `/wiki:add`, `/wiki:merge`

The user can also type `/wiki:ingest <URL>` directly — you don't need to
mediate.

## Core principles

1. **Raw is immutable.** Never edit `raw/articles/<slug>/source.md` after
   ingest. All synthesis happens in `wiki/`.
2. **Cite-or-skip.** Every claim in a wiki article must have a `path:line`
   citation. If you can't cite it, drop the claim.
3. **Incremental by default.** Compile only what the user asks. Don't
   re-compile existing articles unless asked.
4. **Honest gaps.** If the wiki doesn't have the answer, say so. Suggest
   what to ingest (URLs, search terms) to fill the gap.
5. **Respect `default_lang`.** If set in config, the LLM is already
   instructed to respond in that language. Don't override unless asked.
6. **Dedup is automatic.** Re-ingesting the same content returns a
   `duplicate: true` no-op. Re-ingesting different content for the same
   slug fails with a `--force` hint. Don't suggest overwriting without
   confirming with the user.
7. **Hub-aware context.** On every agent turn, a `before_agent_start`
   hook injects up to 3 matching wiki excerpts into the system prompt
   (zero-cost when no matches). You may cite those without re-running
   `/wiki:query`.

## Workflows

### Ingest

```
/wiki:ingest <URL|path> [--tags a,b,c] [--force]
```

- URL: fetched (15s timeout), HTML → markdown via turndown, written with
  YAML frontmatter (title, source, url, ingested_at, tags).
- File: read as-is, written with the same frontmatter.
- Slug derived from URL hash or file path. Same source → same slug.
- Re-ingest of identical content: no-op (`duplicate: true`).
- Re-ingest of different content for same slug: error unless `--force`.
- Frontmatter format:
  ```yaml
  ---
  title: "..."
  source: "url" | "file"
  url: "..."   (if source: url)
  path: "..."  (if source: file)
  ingested_at: "2026-07-22T01:54:01.732Z"
  tags: ["a", "b"]
  ---
  ```

### Compile

```
/wiki:compile                # all raw → all wiki
/wiki:compile --topic <slug> # one raw → one wiki
/wiki:merge --sources a,b [--slug out]  # N raw → 1 merged wiki
```

- Uses the current Pi model via `ctx.model`. The model sees the raw body
  plus a "knowledge-base compiler" system prompt and returns a synthesized
  article.
- Output frontmatter:
  ```yaml
  ---
  title: "..."
  source_slugs: ["<slug>"]
  compiled_at: "2026-07-22T..."
  ---
  ```
- Idempotent: re-running overwrites the existing `wiki/<slug>/index.md`.
- `runCompile` fails with a clear error if the LLM returns an empty
  summary (e.g. due to a model hiccup or rate limit). Suggest the user
  try a different model or inspect the raw with `/wiki:show`.

### Search (LLM-driven)

```
/wiki:search "query" [--limit N]   # slash only — LLM WebSearch + auto-ingest
```

- Uses the LLM's WebSearch tool to find N URLs, ingests each, returns a
  summary. Requires WebSearch enabled in Pi (e.g. `OPENCODE_ENABLE_EXA=1`).
- The tool name is `wiki_search` for the LLM but there is no
  `wiki_search` registered — the slash command is the only entry point.

### Query

```
/wiki:query <text> [--tag <name>] [--max-matches N]
```

- Greps `wiki/` and `raw/articles/` for matching lines (case-insensitive
  substring). Top N matches (default 5) sorted by line.
- If `tag` is set, only files whose effective tags include it are searched
  (wiki files inherit tags from their `source_slugs`).
- Calls the current Pi model with a synthesis prompt: "Write a
  one-paragraph answer that cites each non-trivial claim with `path:line`."
- Returns the synthesized answer plus the citation list.

### List / Show

```
/wiki:ls [--tag <name>]
/wiki:show <slug>
```

- `ls` returns a markdown table of all ingested articles. With a tag
  filter, only matching articles are shown. Reads from
  `raw/articles/_index.md` if present (auto-regenerated), otherwise
  walks the directory live.
- `show` returns the full frontmatter + body of one article by slug.
  Slug is required (no fuzzy match in v0.9).

### Lint

```
/wiki:lint
```

- 5 checks across all `raw/articles/` and `wiki/` files:
  1. **frontmatter** (error) — missing `---` or required fields
     (title, source, ingested_at)
  2. **wikilinks** (warning) — `[[X]]` targets that don't resolve to an
     existing file
  3. **empty** (warning) — whitespace-only files or empty bodies
  4. **duplicate** (warning) — same SHA-1 body hash in two raw files
  5. **tags** (warning / info) — non-normalized tags (case, whitespace) or
     duplicates after normalization
- Output: severity-grouped markdown tables.

### Index

```
/wiki:index            # read wiki/_index.md
/wiki:index --rebuild  # force regenerate from disk
```

- Auto-regenerated by `wiki:compile` and `wiki:merge`.
- Read-only by default; `--rebuild` regenerates.

## Indexes

Every existing directory in the hub has an `_index.md` listing its
contents in a markdown table. After every ingest/compile, indexes are
auto-regenerated. Read indexes first, never scan blindly.

## Quick navigation

1. **New to the hub?** `/wiki:ls` to see what's there.
2. **Got a URL to add?** `/wiki:ingest <URL>` or `/wiki:add <URL>`.
3. **Got a search query?** `/wiki:search "term"` to find+ingest, or
   `/wiki:query "term"` to query existing content.
4. **Got many raws to merge?** `/wiki:merge --sources a,b,c --slug out`.
5. **Got a question about the content?** `/wiki:query "question"`.
6. **Something looks wrong?** `/wiki:lint`.

## Common mistakes to avoid

- **Don't** modify `raw/articles/<slug>/source.md` after ingest. If the
  user asks for corrections, fix the wiki article, not the raw.
- **Don't** re-compile everything. The user has to ask explicitly. If
  you do re-compile, you overwrite all existing wiki articles.
- **Don't** invoke `wiki_search` (the tool doesn't exist). Use the
  `/wiki:search` slash command or call `wiki_ingest` with a specific URL.
- **Don't** assume hub content is in training data. Read the wiki files
  directly when you need to cite something.
- **Don't** create raw content with `wiki_ingest` for things the user
  asked you to remember — that's what `wiki_query` or a wiki article
  is for.

## Boot

When this file is read at session start, follow the **active wiki identity**
convention:

```
<wiki-name> booted from <wiki-root-path>
```

Use the basename of `hub_path` (e.g. `wiki` for `~/wiki`).

## Reference

- Source: <https://github.com/giocom/pi-llm-wiki>
- Reference design (navigate for the bigger picture): <https://github.com/nvk/llm-wiki/blob/master/AGENTS.md>
- Pi extension docs: <https://pi.dev/docs/extensions>
