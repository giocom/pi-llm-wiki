/**
 * pi-llm-wiki v0.6 — `/wiki:add`
 *
 * Convenience entry point that chains `ingest` + `compile`:
 *   1. Resolve hub
 *   2. runIngest — write raw/articles/<slug>/source.md
 *   3. (if --no-compile is NOT set) runCompile — write wiki/<slug>/index.md
 *   4. (caller rebuilds indexes; not done here so the LLM call site
 *      can keep the LLM handle out of this pure function)
 *
 * Pure: no LLM is called inside runAdd. The caller injects a stub
 * or a real LLM caller — same pattern as runCompile.
 */

import { runIngest, type IngestInput } from "./ingest.js";
import { runCompile, type LlmResult } from "./compile.js";

export interface AddOptions {
  hub: string;
  topic?: string;
  noCompile?: boolean;
}

export type AddResult =
  | {
      ok: true;
      ingest: Extract<Awaited<ReturnType<typeof runIngest>>, { ok: true }>;
      compile: Extract<Awaited<ReturnType<typeof runCompile>>, { ok: true }> | null;
    }
  | { ok: false; stage: "ingest" | "compile"; error: string; ingest?: Extract<Awaited<ReturnType<typeof runIngest>>, { ok: true }> };

export async function runAdd(
  input: IngestInput,
  opts: AddOptions,
  llmCaller: ((p: { system: string; user: string }) => Promise<LlmResult>) | null,
): Promise<AddResult> {
  const ingestResult = await runIngest(opts.hub, input);
  if (!ingestResult.ok) {
    return { ok: false, stage: "ingest", error: ingestResult.error };
  }
  if (opts.noCompile || llmCaller === null) {
    return { ok: true, ingest: ingestResult, compile: null };
  }
  const compileResult = await runCompile(
    opts.hub,
    { hub: opts.hub, topic: ingestResult.slug },
    llmCaller,
  );
  if (!compileResult.ok) {
    return { ok: false, stage: "compile", error: compileResult.error, ingest: ingestResult };
  }
  return { ok: true, ingest: ingestResult, compile: compileResult };
}

/**
 * Parse `/wiki:add <args>` into (input, options). Mirrors parseIngestArgs
 * but also recognizes --no-compile.
 */
export function parseAddArgs(args: string): { input: IngestInput; noCompile: boolean } | { error: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { error: "Usage: /wiki:add <URL or file path> [--tags a,b,c] [--no-compile]" };
  }
  const tokens = trimmed.split(/\s+/);
  let tags: string[] | undefined;
  let positional = "";
  let noCompile = false;
  for (const tok of tokens) {
    if (tok === "--no-compile") {
      noCompile = true;
      continue;
    }
    if (tok.startsWith("--tags=")) {
      tags = tok.slice("--tags=".length).split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (tok === "--tags") continue;
    if (positional === "" && !tok.startsWith("--")) {
      positional = tok;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--tags" && i + 1 < tokens.length) {
      tags = tokens[i + 1]!.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (positional === "") {
    return { error: "Provide a URL or file path. Usage: /wiki:add <URL|path> [--tags ...] [--no-compile]" };
  }
  if (/^https?:\/\//i.test(positional)) {
    return { input: { kind: "url", url: positional, tags }, noCompile };
  }
  return { input: { kind: "file", path: positional, tags }, noCompile };
}
