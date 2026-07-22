/**
 * pi-llm-wiki v0.2 — `/wiki:ls` and `/wiki:show`
 *
 * Pure file-system reads under <hub>/raw/articles/. No LLM, no Pi dep.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// ─── Frontmatter parsing (minimal) ────────────────────────────────────

/**
 * Parse a YAML frontmatter block at the top of a markdown file.
 * Returns an object with the key/value pairs. v0.2 supports:
 *   - string values
 *   - array of strings (lines under `key:` indented with `  - "..."`)
 * Unrecognized shapes are coerced to strings.
 */
export function parseFrontmatter(content: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { meta: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    return { meta: {}, body: content };
  }
  const fmBlock = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");

  const meta: Record<string, string | string[]> = {};
  const lines = fmBlock.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1]!;
    const value = m[2]!.trim();

    if (value === "[]") {
      meta[key] = [];
      i++;
      continue;
    }
    if (value === "") {
      // Could be an array on the following lines
      const arr: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const sub = lines[j]!;
        const am = /^\s+-\s*(.*)$/.exec(sub);
        if (!am) break;
        arr.push(unquote(am[1]!.trim()));
        j++;
      }
      if (arr.length > 0) {
        meta[key] = arr;
        i = j;
        continue;
      }
    }
    meta[key] = unquote(value);
    i++;
  }
  return { meta, body };
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

// ─── List (ls) ────────────────────────────────────────────────────────

export interface ArticleInfo {
  slug: string;
  title: string;
  source: string;
  tags: string[];
  ingestedAt: string;
}

export type ListResult =
  | { ok: true; articles: ArticleInfo[] }
  | { ok: false; error: string };

/**
 * List all ingested articles under <hub>/raw/articles/.
 * Each slug is a directory containing source.md.
 */
export function listArticles(hub: string): ListResult {
  const root = join(hub, "raw", "articles");
  if (!existsSync(root)) {
    return { ok: true, articles: [] };
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    return { ok: false, error: `readdir error: ${(err as Error).message}` };
  }
  const articles: ArticleInfo[] = [];
  for (const slug of entries.sort()) {
    const sourcePath = join(root, slug, "source.md");
    if (!existsSync(sourcePath)) continue;
    let content: string;
    try {
      content = readFileSync(sourcePath, "utf8");
    } catch {
      continue;
    }
    const { meta } = parseFrontmatter(content);
    articles.push({
      slug,
      title: typeof meta.title === "string" ? meta.title : slug,
      source: typeof meta.source === "string" ? meta.source : "unknown",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      ingestedAt: typeof meta.ingested_at === "string" ? meta.ingested_at : "",
    });
  }
  return { ok: true, articles };
}

/**
 * Format an ArticleInfo[] as a markdown table.
 * Columns: slug | title | source | tags | ingested_at
 */
export function formatArticlesTable(articles: ArticleInfo[]): string {
  if (articles.length === 0) {
    return "No ingested articles yet. Use `/wiki:ingest <URL|path>` to add one.";
  }
  const lines: string[] = [];
  lines.push("| slug | title | source | tags | ingested_at |");
  lines.push("|------|-------|--------|------|--------------|");
  for (const a of articles) {
    const tags = a.tags.length > 0 ? a.tags.map((t) => `\`${t}\``).join(", ") : "—";
    const ingested = a.ingestedAt ? a.ingestedAt.replace("T", " ").replace(/\..*$/, "") : "—";
    lines.push(
      `| \`${a.slug}\` | ${escapeMd(a.title)} | ${a.source} | ${tags} | ${ingested} |`,
    );
  }
  return lines.join("\n");
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ─── Show ─────────────────────────────────────────────────────────────

export type ShowResult =
  | { ok: true; slug: string; content: string }
  | { ok: false; error: string };

/**
 * Read a single ingested article's full content (frontmatter + body).
 */
export function showArticle(hub: string, slug: string): ShowResult {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    return { ok: false, error: `Invalid slug: ${slug}` };
  }
  const filePath = join(hub, "raw", "articles", slug, "source.md");
  if (!existsSync(filePath)) {
    return { ok: false, error: `No such article: ${slug}. Use \`/wiki:ls\` to see available slugs.` };
  }
  try {
    const content = readFileSync(filePath, "utf8");
    return { ok: true, slug, content };
  } catch (err) {
    return { ok: false, error: `read error: ${(err as Error).message}` };
  }
}

// Re-export basename for test convenience.
export { basename, statSync };
