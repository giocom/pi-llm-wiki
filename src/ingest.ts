/**
 * pi-llm-wiki v0.1 — `/wiki:ingest`
 *
 * Pure functions for ingesting a single source (URL or local file) into a
 * local llm-wiki hub. No Pi dependency — these functions can be unit-tested
 * and reused outside Pi.
 *
 * Output layout (v0.1):
 *   <hub>/raw/articles/<slug>/source.md
 *
 * Frontmatter (YAML):
 *   ---
 *   title: "..."
 *   source: "url" | "file"
 *   url: "..."   (if source: url)
 *   path: "..."  (if source: file)
 *   ingested_at: "ISO 8601"
 *   tags: ["a", "b"]
 *   ---
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import TurndownService from "turndown";

// ─── Types ────────────────────────────────────────────────────────────

export type ParsedInput =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string };

export type IngestInput =
  | { kind: "url"; url: string; tags?: string[] }
  | { kind: "file"; path: string; tags?: string[] };

export interface IngestMeta {
  title: string;
  source: "url" | "file";
  url?: string;
  path?: string;
  ingestedAt: string;
  tags: string[];
}

export type IngestResult =
  | { ok: true; slug: string; writtenPath: string; summary: string }
  | { ok: false; error: string };

// ─── Input parsing ────────────────────────────────────────────────────

/**
 * Classify a user-supplied string as either a URL or a local file path.
 * URLs are detected by the http(s):// prefix. Anything else is treated
 * as a file path (relative or absolute).
 */
export function parseInput(s: string): ParsedInput {
  const trimmed = s.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "url", url: trimmed };
  }
  return { kind: "file", path: trimmed };
}

// ─── Slug generation ──────────────────────────────────────────────────

/**
 * Slug = first 12 hex chars of SHA-1(normalized URL).
 * Normalization: trim + lowercase the scheme/host; keep path/query/fragment
 * as-is. v0.1 — no advanced URL canonicalization (e.g. trailing slashes
 * are NOT stripped, query-param ordering is preserved).
 */
export function slugFromUrl(url: string): string {
  const normalized = url.trim();
  return hash12(normalized);
}

/**
 * Slug = first 12 hex chars of SHA-1(absolute path). We resolve to absolute
 * first so relative and absolute forms of the same file hash the same.
 */
export function slugFromPath(p: string): string {
  return hash12(resolve(p));
}

function hash12(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);
}

// ─── HTML stripping (v0.1, naive) ─────────────────────────────────────

/**
 * Strip HTML to plain markdown-ish text. v0.1 is intentionally minimal:
 *   - remove <script>...</script>
 *   - remove <style>...</style>
 *   - strip remaining tags
 *   - decode a few common HTML entities
 *   - collapse runs of whitespace
 *   - preserve paragraph breaks as double newlines
 *
 * v0.2+ will replace this with a real HTML→Markdown converter
 * (turndown or similar). For now this is good enough to learn the flow.
 */
export function stripHtml(html: string): string {
  let s = html;

  // Remove script/style blocks (case-insensitive, multiline)
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // Block-level closers → paragraph break
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>/gi, "\n\n");
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");

  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");

  // Decode common HTML entities (only the ones we need for v0.1)
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));

  // Collapse 3+ newlines → 2
  s = s.replace(/\n{3,}/g, "\n\n");
  // Collapse 2+ spaces → 1
  s = s.replace(/[ \t]{2,}/g, " ");
  // Trim each line
  s = s
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  return s.trim();
}

/**
 * HTML → Markdown via turndown. Used for URL ingest in v0.7+.
 * Falls back to `stripHtml` if turndown throws or produces an empty result.
 *
 * The `_url` parameter is reserved for future use (turndown plugins like
 * turndown-plugin-gfm can resolve relative URLs to absolute).
 */
export function htmlToMarkdown(html: string, _url?: string): string {
  let markdown: string;
  try {
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      emDelimiter: "*",
    });
    markdown = td.turndown(html);
  } catch {
    return stripHtml(html);
  }
  if (markdown.trim().length === 0) {
    return stripHtml(html);
  }
  return markdown;
}

// ─── Frontmatter (v0.1, hand-rolled YAML) ─────────────────────────────

/**
 * Build a YAML frontmatter block (with leading and trailing `---`).
 * Hand-rolled: avoids pulling in a YAML library for v0.1. Only handles
 * the values we generate (strings, string arrays). Quote-escapes `"` in
 * string values.
 */
export function buildFrontmatter(meta: IngestMeta): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${yamlString(meta.title)}`);
  lines.push(`source: ${yamlString(meta.source)}`);
  if (meta.url !== undefined) lines.push(`url: ${yamlString(meta.url)}`);
  if (meta.path !== undefined) lines.push(`path: ${yamlString(meta.path)}`);
  lines.push(`ingested_at: ${yamlString(meta.ingestedAt)}`);
  if (meta.tags.length === 0) {
    lines.push("tags: []");
  } else {
    lines.push("tags:");
    for (const t of meta.tags) {
      lines.push(`  - ${yamlString(t)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlString(s: string): string {
  // Always double-quote; escape `\` and `"`.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ─── File writing ─────────────────────────────────────────────────────

/**
 * Write the ingested file to <hub>/raw/articles/<slug>/source.md.
 * Creates intermediate directories. Returns the absolute written path.
 */
export function writeIngestedFile(
  hub: string,
  slug: string,
  body: string,
): string {
  const dir = join(hub, "raw", "articles", slug);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "source.md");
  writeFileSync(filePath, body, "utf8");
  return filePath;
}

// ─── Top-level entry ──────────────────────────────────────────────────

/**
 * Run the full ingest pipeline: parse input → fetch/read body → strip
 * HTML (if URL) → build frontmatter → write file.
 *
 * Never throws. All errors become an `{ ok: false, error }` result with
 * a user-readable message. The caller is responsible for surfacing the
 * error to the user (notify / tool result).
 */
export async function runIngest(hub: string, input: IngestInput): Promise<IngestResult> {
  if (!existsSync(hub)) {
    return { ok: false, error: `Hub path does not exist: ${hub}` };
  }

  let slug: string;
  let meta: IngestMeta;
  let body: string;

  const ingestedAt = new Date().toISOString();
  const tags = input.tags ?? [];

  if (input.kind === "url") {
    slug = slugFromUrl(input.url);
    meta = {
      title: input.url,
      source: "url",
      url: input.url,
      ingestedAt,
      tags,
    };

    let html: string;
    try {
      const res = await fetch(input.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `Fetch failed: ${res.status} ${res.statusText} for ${input.url}`,
        };
      }
      html = await res.text();
    } catch (err) {
      return {
        ok: false,
        error: `Fetch error: ${(err as Error).message} for ${input.url}`,
      };
    }

    body = htmlToMarkdown(html, input.url);
  } else {
    // file
    if (!existsSync(input.path)) {
      return { ok: false, error: `File does not exist: ${input.path}` };
    }
    let st;
    try {
      st = statSync(input.path);
    } catch (err) {
      return { ok: false, error: `stat error: ${(err as Error).message}` };
    }
    if (!st.isFile()) {
      return { ok: false, error: `Not a regular file: ${input.path}` };
    }

    slug = slugFromPath(input.path);
    const title = basename(input.path);
    meta = {
      title,
      source: "file",
      path: resolve(input.path),
      ingestedAt,
      tags,
    };

    try {
      body = readFileSync(input.path, "utf8");
    } catch (err) {
      return { ok: false, error: `Read error: ${(err as Error).message}` };
    }
  }

  const frontmatter = buildFrontmatter(meta);
  const full = `${frontmatter}\n\n${body}\n`;

  let writtenPath: string;
  try {
    writtenPath = writeIngestedFile(hub, slug, full);
  } catch (err) {
    return { ok: false, error: `Write error: ${(err as Error).message}` };
  }

  const summary = `Ingested ${meta.source} "${meta.title}" → ${writtenPath} (slug: ${slug})`;
  return { ok: true, slug, writtenPath, summary };
}

// Re-export `resolve` so test imports compile cleanly.
export { resolve, dirname };
