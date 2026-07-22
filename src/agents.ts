/**
 * pi-llm-wiki v0.11 — AGENTS.md auto-injection
 *
 * Reads the pi-llm-wiki AGENTS.md (or AGENTS-ko.md when default_lang
 * is "ko") from the extension's own source directory and returns
 * a system-prompt fragment that the before_agent_start hook can
 * append to the LLM's context.
 *
 * Why: unlike Claude Code/Codex/OpenCode, Pi does not auto-read
 * AGENTS.md from the working directory. The extension ships its
 * own copy of the file in its own source tree, and the hook
 * injects the contents at session start so the LLM knows the
 * available tools, hub layout, and core principles.
 *
 * Behaviour:
 *   - No AGENTS.md found → returns null (zero-cost no-op).
 *   - File too large → returns null with a one-line warning,
 *     to keep the system prompt bounded.
 *   - default_lang === "ko" → prefer AGENTS-ko.md, fall back to
 *     AGENTS.md.
 *   - All other default_lang → prefer AGENTS.md (no -ko fallback
 *     for Korean).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_AGENTS_BYTES = 16_000;

function findExtensionRoot(): string | null {
  // The extension is bundled at <extRoot>/dist/index.js when running.
  // The source AGENTS.md lives at <extRoot>/AGENTS.md (English) and
  // <extRoot>/AGENTS-ko.md (Korean). We resolve relative to this
  // module's location so it works both in source (./src/agents.ts)
  // and built (./dist/agents.js) form.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..");
  } catch {
    return null;
  }
}

function readIfExists(p: string): string | null {
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read the AGENTS.md content from the extension's own source tree.
 * Returns null when the file is missing, too large, or unreadable.
 */
export function readAgentsFile(lang?: string | null): string | null {
  const root = findExtensionRoot();
  if (!root) return null;

  const wantKorean = typeof lang === "string" && lang.toLowerCase().startsWith("ko");
  const primary = wantKorean ? "AGENTS-ko.md" : "AGENTS.md";
  const secondary = wantKorean ? "AGENTS.md" : null;

  const primaryPath = join(root, primary);
  let content = readIfExists(primaryPath);
  if (content === null && secondary) {
    content = readIfExists(join(root, secondary));
  }
  if (content === null) return null;
  if (content.length > MAX_AGENTS_BYTES) return null;
  return content;
}

/**
 * Build the system-prompt fragment that the before_agent_start hook
 * should append. Wraps the AGENTS.md body with a clear marker so
 * the LLM knows where it came from.
 *
 * Returns null when no AGENTS.md is available — caller should leave
 * the system prompt unchanged.
 */
export function buildAgentsContext(lang?: string | null): string | null {
  const body = readAgentsFile(lang);
  if (body === null) return null;
  return [
    "## pi-llm-wiki — agent instructions",
    "",
    "The following is the agent reference for the pi-llm-wiki extension installed in this session.",
    "",
    body,
  ].join("\n");
}

/**
 * Trigger words/phrases that indicate the user is asking for a wiki
 * operation. Match is case-insensitive substring on the lowercased
 * prompt. Single-word matches use word boundaries so e.g. "wiki" in
 * "wikipedia" does NOT trigger; explicit phrase matches (`/wiki:`)
 * are checked as plain substrings.
 */
const WIKI_TRIGGERS: ReadonlyArray<string> = [
  "/wiki",
  "wiki-",
  "wiki ",
  "wiki:",
  "wiki.",
  "wiki,",
  "wiki로",
  "wiki에",
  "wiki의",
  "위키",
  "워크",
  "워키",
  "정리해",
  "정리 좀",
  "요약해",
  "컴파일",
  "만들어",
  "작성해",
  "인덱스",
  "ingest",
  "compile",
  "query",
  "merge",
  "lint",
];

/**
 * Return true if the prompt contains any wiki-related trigger word or
 * phrase. Used by the before_agent_start hook to gate AGENTS.md
 * injection so we don't spend ~3-4k tokens per turn on prompts
 * that are clearly not about the wiki.
 */
export function hasWikiTrigger(prompt: string): boolean {
  if (typeof prompt !== "string" || prompt.length === 0) return false;
  const lower = prompt.toLowerCase();
  for (const pattern of WIKI_TRIGGERS) {
    if (lower.includes(pattern.toLowerCase())) return true;
  }
  return false;
}
