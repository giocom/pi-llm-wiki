/**
 * pi-llm-wiki v0.8 — session context auto-injection
 *
 * Before each agent turn, extract keywords from the user's prompt and
 * grep the local hub for matching articles. If matches are found, append
 * a short "Wiki context" block to the system prompt so the LLM can
 * cite the user's own wiki when answering.
 *
 * Design notes:
 *   - No LLM call. Pure grep + formatting.
 *   - Keywords are simple whitespace-split + stopword filter.
 *   - Worst case: 0 matches → no injection (cheap).
 *   - Best case: 1–3 matches → small context block (~500 tokens).
 *   - Wiki files inherit tags from their source_slugs (see list.ts).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileMatchesTag } from "./list.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "not", "no", "is", "are", "was",
  "were", "be", "been", "being", "to", "of", "in", "for", "on", "at", "by",
  "with", "from", "as", "this", "that", "these", "those", "it", "its",
  "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "their", "our", "what", "which", "who", "when",
  "where", "why", "how", "can", "could", "would", "should", "will", "may",
  "might", "do", "does", "did", "have", "has", "had", "if", "then",
  "than", "so", "just", "very", "really", "like", "also", "into", "out",
  "up", "down", "over", "under", "about",
]);

/**
 * Tokenize a user prompt into 1–5 searchable keywords.
 *   - lowercase
 *   - strip non-alphanumeric (but keep hyphens and CJK characters)
 *   - drop stopwords and very short tokens (< 3 chars)
 *   - dedup
 *   - cap at 5
 */
export function extractKeywords(prompt: string): string[] {
  const tokens = prompt
    .toLowerCase()
    .split(/[\s,;.!?()[\]{}'"/\\]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= 5) break;
  }
  return out;
}

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
    else if (st.isFile() && entry.endsWith(".md") && entry !== "_index.md") out.push(full);
  }
  return out;
}

export interface ContextMatch {
  path: string;
  relativePath: string;
  line: number;
  excerpt: string;
  citation: string;
}

/**
 * Grep the hub for any of the given keywords. Returns up to `maxMatches`
 * unique matches (case-insensitive substring), ranked by earliest line.
 */
export function grepForKeywords(hub: string, keywords: string[], maxMatches = 3): ContextMatch[] {
  if (keywords.length === 0) return [];
  const roots = [join(hub, "wiki"), join(hub, "raw", "articles")];
  const seen = new Set<string>();
  const out: ContextMatch[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of listMarkdownFiles(root)) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.toLowerCase();
        const matched = keywords.some((k) => line.includes(k));
        if (!matched) continue;
        const rel = relative(hub, file);
        const citation = `${rel}:${i + 1}`;
        if (seen.has(citation)) continue;
        seen.add(citation);
        out.push({
          path: file,
          relativePath: rel,
          line: i + 1,
          excerpt: lines[i]!.trim(),
          citation,
        });
        if (out.length >= maxMatches) return out;
      }
    }
  }
  return out;
}

/**
 * Format a list of matches as a markdown block suitable for the
 * system prompt.
 */
export function formatContextBlock(matches: ContextMatch[]): string {
  if (matches.length === 0) return "";
  const lines: string[] = [];
  lines.push("## Wiki context (auto-injected)");
  lines.push("");
  lines.push("Excerpts from the user's local llm-wiki hub that may be relevant:");
  lines.push("");
  for (const m of matches) {
    lines.push(`### \`${m.citation}\``);
    lines.push("");
    lines.push("```");
    lines.push(m.excerpt);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Top-level: given a hub and a user prompt, return a context block
 * (markdown) or null if no relevant matches were found.
 */
export function buildContextForPrompt(hub: string, prompt: string, maxMatches = 3): string | null {
  if (!existsSync(hub)) return null;
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) return null;
  const matches = grepForKeywords(hub, keywords, maxMatches);
  if (matches.length === 0) return null;
  return formatContextBlock(matches);
}
