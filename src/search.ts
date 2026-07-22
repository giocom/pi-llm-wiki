/**
 * pi-llm-wiki v0.5 — `/wiki:search`
 *
 * Indirect search via the LLM. We don't call a search API ourselves;
 * we tell the LLM (via a one-shot user message) to use its WebSearch
 * tool, find N relevant URLs, and call `wiki_ingest` for each one.
 *
 * Why indirect:
 *   - Pi exposes WebSearch as a built-in LLM tool (no public extension
 *     API for it). Letting the LLM drive it avoids re-implementing
 *     provider/model glue.
 *   - The LLM can pick the most relevant URLs from a candidate set.
 *
 * Requirements for this to work:
 *   - Pi's WebSearch tool must be enabled (e.g. OPENCODE_ENABLE_EXA=1
 *     for the OpenCode provider, or equivalent for others).
 *   - The LLM must know about `wiki_ingest` (registered in v0.1).
 */

export interface SearchRequest {
  query: string;
  limit: number;
}

export interface SearchHint {
  /** One-shot user message sent to the agent, prompting it to act. */
  prompt: string;
  /** Tag that will be applied to every ingested result. */
  tag: string;
}

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;

/**
 * Parse `/wiki:search <args>` into a SearchRequest.
 * Supports `--limit N` and `--tags a,b,c` (latter is currently unused
 * but reserved for future per-call tag overrides).
 */
export function parseSearchArgs(args: string): { request: SearchRequest; positional: string } | { error: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { error: "Usage: /wiki:search <query> [--limit N]" };
  }
  const tokens = trimmed.split(/\s+/);
  let limit = DEFAULT_LIMIT;
  let positional = "";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--limit=")) {
      const n = Number(tok.slice("--limit=".length));
      if (!Number.isFinite(n) || n < 1) {
        return { error: `--limit must be a positive integer (got "${tok.slice(8)}")` };
      }
      limit = Math.min(MAX_LIMIT, Math.floor(n));
    } else if (tok === "--limit" && i + 1 < tokens.length) {
      const n = Number(tokens[i + 1]);
      if (!Number.isFinite(n) || n < 1) {
        return { error: `--limit must be a positive integer` };
      }
      limit = Math.min(MAX_LIMIT, Math.floor(n));
      i++;
    } else if (positional === "" && !tok.startsWith("--")) {
      positional = tok;
    }
  }
  // Combine remaining tokens as the query (in case the user used multiple words)
  const queryTokens: string[] = [];
  let skipNext = false;
  for (let i = 0; i < tokens.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const tok = tokens[i]!;
    if (tok === "--limit") {
      skipNext = true;
      continue;
    }
    if (tok.startsWith("--limit=")) continue;
    queryTokens.push(tok);
  }
  const query = queryTokens.join(" ").trim();
  if (query.length === 0) {
    return { error: "Provide a search query. Usage: /wiki:search <query> [--limit N]" };
  }
  return { request: { query, limit }, positional: query };
}

/**
 * Normalize a search query into a single tag:
 *   - lowercase
 *   - collapse whitespace
 *   - replace whitespace with hyphens
 *   - strip characters that aren't [a-z0-9-]
 */
export function normalizeSearchTag(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Build the one-shot user message that prompts the LLM to perform the
 * search and ingest cycle. The message is intentionally imperative —
 * the LLM should treat it as a concrete instruction, not a question.
 */
export function buildSearchPrompt(query: string, limit: number, tag: string): string {
  return [
    `Search the web for "${query}" and ingest the ${limit} most relevant URL${limit === 1 ? "" : "s"} into the local llm-wiki hub.`,
    ``,
    `For each URL:`,
    `  1. Use your WebSearch tool if needed to find candidate URLs.`,
    `  2. Fetch the URL and call the \`wiki_ingest\` tool with { source: "url", url: "<the url>", tags: ["${tag}"] }.`,
    `  3. Confirm the ingest succeeded.`,
    ``,
    `Constraints:`,
    `  - Prefer authoritative sources (official docs, GitHub READMEs, well-known blogs).`,
    `  - Skip paywalled, login-walled, or empty pages.`,
    `  - Stop after ${limit} successful ingest${limit === 1 ? "" : "s"} (don't try more).`,
    `  - If a fetch fails, try the next URL; don't give up after one failure.`,
    `  - When done, summarize what you ingested with each \`path:line\` citation.`,
  ].join("\n");
}

export function buildSearchHint(req: SearchRequest): SearchHint {
  const tag = normalizeSearchTag(req.query);
  return {
    prompt: buildSearchPrompt(req.query, req.limit, tag),
    tag,
  };
}

export const SEARCH_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const SEARCH_MAX_LIMIT = MAX_LIMIT;
