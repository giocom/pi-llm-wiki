/**
 * pi-llm-wiki v0.2 — `/wiki:query`
 *
 * Greps wiki/ and raw/articles/ for the query text, takes top 5 matches
 * (sorted by line count desc), then asks the LLM to synthesize a
 * one-paragraph answer with inline path:line citations.
 *
 * The LLM step is optional via the `llmCaller` injection. If null, the
 * function returns just the grep matches (caller can decide to skip
 * synthesis).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { callLlm, type LlmResult } from "./llm.js";

export interface QueryOptions {
  hub: string;
  query: string;
  maxMatches?: number;
}

export interface QueryMatch {
  path: string;
  relativePath: string;
  line: number;
  excerpt: string;
  citation: string;
}

export type QueryResult =
  | {
      ok: true;
      matches: QueryMatch[];
      answer: string;
      usedLlm: boolean;
    }
  | { ok: false; error: string };

/**
 * Recursively list .md files under `dir`.
 */
function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (st.isFile() && entry.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Grep a single file for the query, returning matches with 1 line of context.
 */
function grepFile(hub: string, file: string, query: string): QueryMatch[] {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n");
  const needle = query.toLowerCase();
  const out: QueryMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.toLowerCase().includes(needle)) continue;
    const start = Math.max(0, i - 1);
    const end = Math.min(lines.length - 1, i + 1);
    const excerptLines: string[] = [];
    for (let j = start; j <= end; j++) {
      excerptLines.push(`${j + 1}: ${lines[j]}`);
    }
    const rel = relative(hub, file);
    out.push({
      path: file,
      relativePath: rel,
      line: i + 1,
      excerpt: excerptLines.join("\n"),
      citation: `${rel}:${i + 1}`,
    });
  }
  return out;
}

function rankMatches(matches: QueryMatch[]): QueryMatch[] {
  // Simple: sort by line ascending (earlier = more important) and dedup by citation
  const seen = new Set<string>();
  const uniq: QueryMatch[] = [];
  for (const m of [...matches].sort((a, b) => a.line - b.line)) {
    if (seen.has(m.citation)) continue;
    seen.add(m.citation);
    uniq.push(m);
  }
  return uniq;
}

/**
 * Run the grep step only. No LLM call.
 */
export function grepHub(hub: string, query: string, maxMatches = 5): QueryMatch[] {
  if (query.trim().length === 0) return [];
  const roots = [join(hub, "wiki"), join(hub, "raw", "articles")];
  const all: QueryMatch[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of listMarkdownFiles(root)) {
      all.push(...grepFile(hub, file, query));
    }
  }
  return rankMatches(all).slice(0, maxMatches);
}

export function buildQueryPrompt(matches: QueryMatch[], query: string): {
  system: string;
  user: string;
} {
  const block = matches
    .map((m) => `### \`${m.citation}\`\n\`\`\`\n${m.excerpt}\n\`\`\``)
    .join("\n\n");
  return {
    system:
      "You are a knowledge-base assistant. Given a user question and a set of " +
      "cited excerpts from a local wiki, write a one-paragraph answer that " +
      "directly addresses the question. Cite each non-trivial claim inline " +
      "using the exact `path:line` citation from the source (e.g. " +
      "\"The key idea is X (wiki/foo/index.md:5).\"). " +
      "If the excerpts don't contain the answer, say so. Do not invent facts.",
    user:
      `Question: ${query}\n\n` +
      `Excerpts:\n${block || "(no matches)"}`,
  };
}

function formatAnswerWithoutLlm(matches: QueryMatch[], query: string): string {
  if (matches.length === 0) {
    return `No matches for "${query}".`;
  }
  const lines = [`Found ${matches.length} match(es) for "${query}":`, ""];
  for (const m of matches) {
    lines.push(`### \`${m.citation}\``);
    lines.push("```");
    lines.push(m.excerpt);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Top-level: grep + LLM synthesis.
 */
export async function runQuery(
  opts: QueryOptions,
  llmCaller: ((p: { system: string; user: string }) => Promise<LlmResult>) | null,
): Promise<QueryResult> {
  if (!existsSync(opts.hub)) {
    return { ok: false, error: `Hub path does not exist: ${opts.hub}` };
  }
  const matches = grepHub(opts.hub, opts.query, opts.maxMatches ?? 5);
  if (llmCaller === null) {
    return {
      ok: true,
      matches,
      answer: formatAnswerWithoutLlm(matches, opts.query),
      usedLlm: false,
    };
  }
  const prompt = buildQueryPrompt(matches, opts.query);
  let result: LlmResult;
  try {
    result = await llmCaller(prompt);
  } catch (err) {
    return { ok: false, error: `LLM error: ${(err as Error).message}` };
  }
  return { ok: true, matches, answer: result.text, usedLlm: true };
}

export { callLlm };
