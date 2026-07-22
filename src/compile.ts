/**
 * pi-llm-wiki v0.2 — `/wiki:compile`
 *
 * For each target slug, reads raw/articles/<slug>/source.md, asks the
 * LLM to summarize into a wiki article, and writes wiki/<slug>/index.md.
 *
 * Idempotent: re-running overwrites the index.md (no append).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callLlm, type LlmResult } from "./llm.js";
import { parseFrontmatter } from "./list.js";

export interface CompileOptions {
  hub: string;
  /** When set, only this slug is compiled. Otherwise all slugs in raw/articles/ are processed. */
  topic?: string;
  /** When set, the LLM is not called and the existing index.md is returned if present, else an error. */
  dryRun?: boolean;
}

export type CompileResult =
  | {
      ok: true;
      compiled: Array<{
        slug: string;
        wikiPath: string;
        title: string;
        bytesIn: number;
        bytesOut: number;
      }>;
    }
  | { ok: false; error: string };

/**
 * List slugs to compile based on options.
 */
export function selectSlugs(hub: string, topic?: string): string[] {
  const root = join(hub, "raw", "articles");
  if (!existsSync(root)) return [];
  const all = readdirSync(root).filter((d) => {
    try {
      return existsSync(join(root, d, "source.md"));
    } catch {
      return false;
    }
  });
  if (!topic) return all.sort();
  if (!all.includes(topic)) return [];
  return [topic];
}

/**
 * Build the prompt asking the LLM to summarize one raw source into a wiki article.
 */
export function buildCompilePrompt(meta: Record<string, string | string[]>, body: string): {
  system: string;
  user: string;
} {
  const title = typeof meta.title === "string" ? meta.title : "Untitled";
  const tags = Array.isArray(meta.tags) ? meta.tags.join(", ") : "none";
  return {
    system:
      "You are a knowledge-base compiler. Given a single source document, write a concise wiki article in markdown. " +
      "Preserve key facts, names, and numbers. Use clear headings. Keep it shorter than the source (aim for ~30% length). " +
      "Do not invent facts. Do not include YAML frontmatter — that is added by the caller. " +
      "Output ONLY the article body, no preamble, no explanation.",
    user:
      `Source title: ${title}\n` +
      `Tags: ${tags}\n\n` +
      `<source>\n${body}\n</source>\n\n` +
      `Write the wiki article body.`,
  };
}

/**
 * Compose the final wiki markdown: frontmatter + LLM body.
 */
export function buildWikiMarkdown(slug: string, title: string, body: string, sourceSlug: string): string {
  const frontmatter = [
    "---",
    `title: ${yamlQuote(title)}`,
    `source_slugs:`,
    `  - ${yamlQuote(sourceSlug)}`,
    `compiled_at: ${yamlQuote(new Date().toISOString())}`,
    "---",
    "",
  ].join("\n");
  return frontmatter + body.trim() + "\n";
}

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write a compiled wiki file. Idempotent — overwrites.
 */
export function writeWikiFile(hub: string, slug: string, content: string): string {
  const dir = join(hub, "wiki", slug);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "index.md");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/**
 * Compile a single slug. Returns the wiki path and stats. Does NOT call the LLM
 * when `llm` is null — useful for tests.
 */
export async function compileOne(
  hub: string,
  slug: string,
  llm: ((prompt: { system: string; user: string }) => Promise<LlmResult>) | null,
): Promise<CompileResult> {
  const sourcePath = join(hub, "raw", "articles", slug, "source.md");
  if (!existsSync(sourcePath)) {
    return { ok: false, error: `No such slug: ${slug}` };
  }
  let content: string;
  try {
    content = readFileSync(sourcePath, "utf8");
  } catch (err) {
    return { ok: false, error: `read error: ${(err as Error).message}` };
  }
  const { meta, body } = parseFrontmatter(content);
  const title = typeof meta.title === "string" ? meta.title : slug;

  let articleBody: string;
  if (llm === null) {
    // dry-run / test mode: pass through the source body, trimmed
    articleBody = body.trim();
  } else {
    const prompt = buildCompilePrompt(meta, body);
    const result = await llm(prompt);
    articleBody = result.text;
  }

  const md = buildWikiMarkdown(slug, title, articleBody, slug);
  const wikiPath = writeWikiFile(hub, slug, md);
  return {
    ok: true,
    compiled: [
      {
        slug,
        wikiPath,
        title,
        bytesIn: content.length,
        bytesOut: md.length,
      },
    ],
  };
}

/**
 * Top-level: compile all (or one) slugs. `llmCaller` is injected so tests
 * can pass a stub. The real caller is `callLlm` from `llm.ts`.
 */
export async function runCompile(
  hub: string,
  opts: CompileOptions,
  llmCaller: ((p: { system: string; user: string }) => Promise<LlmResult>) | null,
): Promise<CompileResult> {
  if (!existsSync(hub)) {
    return { ok: false, error: `Hub path does not exist: ${hub}` };
  }
  const slugs = selectSlugs(hub, opts.topic);
  if (slugs.length === 0) {
    return {
      ok: false,
      error: opts.topic
        ? `No such slug: ${opts.topic}. Use \`/wiki:ls\` to see available slugs.`
        : "No ingested articles to compile. Use `/wiki:ingest` first.",
    };
  }
  const all: Array<{ slug: string; wikiPath: string; title: string; bytesIn: number; bytesOut: number }> = [];
  for (const slug of slugs) {
    const r = await compileOne(hub, slug, llmCaller);
    if (!r.ok) return r;
    all.push(...r.compiled);
  }
  return { ok: true, compiled: all };
}

// Re-export the LLM helper so the shell has a single import path.
export { callLlm, type LlmResult };
