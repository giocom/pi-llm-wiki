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
    articleBody = body.trim();
  } else {
    const prompt = buildCompilePrompt(meta, body);
    const result = await llm(prompt);
    if (!result.text || result.text.trim().length === 0) {
      return {
        ok: false,
        error:
          `LLM returned an empty summary for "${title}" (model: ${result.modelId}). ` +
          `The source body is ${body.length} chars, so this is not an empty-source issue. ` +
          `Try a different model, or run /wiki:add with --no-compile to inspect the raw.`,
      };
    }
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

// ─── Multi-source compile (v0.8) ──────────────────────────────────────

export interface CompileMultiOptions {
  hub: string;
  sources: string[];
  /** Output wiki slug. Defaults to `merged-<timestamp>`. */
  slug?: string;
}

export type CompileMultiResult =
  | {
      ok: true;
      compiled: Array<{
        slug: string;
        wikiPath: string;
        title: string;
        bytesIn: number;
        bytesOut: number;
        sourceSlugs: string[];
      }>;
    }
  | { ok: false; error: string };

/**
 * Build a synthesis prompt that asks the LLM to combine multiple raw
 * sources into a single overview article.
 */
export function buildMultiCompilePrompt(
  items: Array<{ slug: string; meta: Record<string, string | string[]>; body: string }>,
  outputSlug: string,
): { system: string; user: string } {
  const sources = items
    .map(
      (it, i) =>
        `### Source ${i + 1} (slug: \`${it.slug}\`)\n` +
        `Title: ${typeof it.meta.title === "string" ? it.meta.title : "Untitled"}\n\n` +
        `<source>\n${it.body}\n</source>`,
    )
    .join("\n\n");
  return {
    system:
      "You are a knowledge-base compiler. Given multiple source documents, write a single " +
      "synthesis article in markdown that integrates the key ideas, names, and numbers from " +
      "all of them. Use clear headings. Aim for ~30% the combined length of the sources. " +
      "Do not invent facts. Do not include YAML frontmatter — that is added by the caller. " +
      "Output ONLY the article body, no preamble, no explanation.",
    user:
      `Synthesize these ${items.length} sources into a single article. ` +
      `Use the slug \`${outputSlug}\`.\n\n${sources}\n\n` +
      `Write the merged article body.`,
  };
}

function readRawWithMeta(hub: string, slug: string): { ok: true; meta: Record<string, string | string[]>; body: string } | { ok: false; error: string } {
  const sourcePath = join(hub, "raw", "articles", slug, "source.md");
  if (!existsSync(sourcePath)) {
    return { ok: false, error: `No such slug: ${slug}` };
  }
  try {
    const content = readFileSync(sourcePath, "utf8");
    const { meta, body } = parseFrontmatter(content);
    return { ok: true, meta, body };
  } catch (err) {
    return { ok: false, error: `read error: ${(err as Error).message}` };
  }
}

function defaultMultiSlug(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `merged-${ts}`;
}

/**
 * Compile multiple raw sources into a single wiki article. Idempotent
 * — re-running overwrites the output file.
 */
export async function runCompileMulti(
  opts: CompileMultiOptions,
  llmCaller: ((p: { system: string; user: string }) => Promise<LlmResult>) | null,
): Promise<CompileMultiResult> {
  if (!existsSync(opts.hub)) {
    return { ok: false, error: `Hub path does not exist: ${opts.hub}` };
  }
  if (opts.sources.length === 0) {
    return { ok: false, error: "At least one --sources slug is required." };
  }
  const items: Array<{ slug: string; meta: Record<string, string | string[]>; body: string }> = [];
  for (const slug of opts.sources) {
    const r = readRawWithMeta(opts.hub, slug);
    if (!r.ok) return r;
    items.push({ slug, meta: r.meta, body: r.body });
  }
  const outSlug = opts.slug ?? defaultMultiSlug();
  if (!/^[a-zA-Z0-9_-]+$/.test(outSlug)) {
    return { ok: false, error: `Invalid output slug: ${outSlug}` };
  }
  let articleBody: string;
  if (llmCaller === null) {
    const pieces = items.map((it) => `## From ${it.slug}\n\n${it.body.trim()}`);
    articleBody = pieces.join("\n\n");
  } else {
    const prompt = buildMultiCompilePrompt(items, outSlug);
    const result = await llmCaller(prompt);
    articleBody = result.text;
  }
  const title = `Merged: ${items.map((it) => (typeof it.meta.title === "string" ? it.meta.title : it.slug)).join(" + ")}`;
  const md = buildWikiMarkdown(outSlug, title, articleBody, items[0]!.slug);
  // Re-issue with the full source_slugs list
  const mdFinal = md.replace(
    /source_slugs:\n(?:  - .+\n)+/,
    `source_slugs:\n${items.map((it) => `  - ${yamlQuote(it.slug)}`).join("\n")}\n`,
  );
  const wikiPath = writeWikiFile(opts.hub, outSlug, mdFinal);
  const bytesIn = items.reduce((acc, it) => acc + it.body.length, 0);
  return {
    ok: true,
    compiled: [
      {
        slug: outSlug,
        wikiPath,
        title,
        bytesIn,
        bytesOut: mdFinal.length,
        sourceSlugs: items.map((it) => it.slug),
      },
    ],
  };
}

/** Parse `--sources a,b,c` and optional `--slug <name>`. */
export function parseCompileMultiArgs(args: string):
  | { sources: string[]; slug?: string }
  | { error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { error: "Usage: /wiki:compile --sources slug1,slug2 [--slug output-slug]" };
  }
  const sources: string[] = [];
  let slug: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--sources=")) {
      const list = tok.slice("--sources=".length);
      sources.push(...list.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (tok === "--sources" && i + 1 < tokens.length) {
      i++;
      while (i < tokens.length && !tokens[i]!.startsWith("--")) {
        const list = tokens[i]!;
        sources.push(...list.split(",").map((s) => s.trim()).filter(Boolean));
        i++;
      }
      i--;
    } else if (tok.startsWith("--slug=")) {
      slug = tok.slice("--slug=".length);
    } else if (tok === "--slug" && i + 1 < tokens.length) {
      slug = tokens[++i];
    }
  }
  if (sources.length === 0) {
    return { error: "Provide at least one source slug with --sources slug1,slug2." };
  }
  return slug ? { sources, slug } : { sources };
}

// Re-export the LLM helper so the shell has a single import path.
export { callLlm, type LlmResult };
