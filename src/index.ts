/**
 * pi-llm-wiki v0.1 — `/wiki:ingest` and `wiki_ingest` tool
 *
 * Pi shell. The pure logic lives in `ingest.ts`; this file just wires
 * it into Pi's tool and slash-command surfaces.
 *
 * v0.1 hub resolution: read `~/.config/llm-wiki/config.json` for
 * `hub_path`; fall back to `~/wiki`. Inline here; will move to its own
 * module when the next feature needs it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runIngest, parseInput, type IngestInput } from "./ingest.js";

/**
 * Resolve the hub path. Mirrors llm-wiki's convention:
 *   1. ~/.config/llm-wiki/config.json → hub_path (after ~ expansion)
 *   2. ~/wiki
 *
 * Returns null when neither exists. Read-only.
 */
function resolveHubPath(): string | null {
  const home = homedir();
  const configPath = join(home, ".config", "llm-wiki", "config.json");
  const fallback = join(home, "wiki");

  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { hub_path?: string };
      if (typeof cfg.hub_path === "string" && cfg.hub_path.length > 0) {
        const expanded = expandHome(cfg.hub_path);
        if (existsSync(expanded)) return expanded;
      }
    } catch {
      // fall through
    }
  }
  if (existsSync(fallback)) return fallback;
  return null;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Parse the trailing args string from `/wiki:ingest <args>` into an
 * IngestInput. Supports `--tags a,b,c` and a positional URL/path.
 */
function parseSlashArgs(args: string): { input: IngestInput; positional: string } | { error: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { error: "Usage: /wiki:ingest <URL or file path> [--tags a,b,c]" };
  }
  const tokens = trimmed.split(/\s+/);
  let tags: string[] | undefined;
  let positional = "";
  for (const tok of tokens) {
    if (tok.startsWith("--tags=")) {
      tags = tok.slice("--tags=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (tok === "--tags") {
      // next token is the value; handled in a second pass
      continue;
    } else if (positional === "" && !tok.startsWith("--")) {
      positional = tok;
    }
  }
  // Second pass for `--tags value` (space-separated)
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--tags" && i + 1 < tokens.length) {
      tags = tokens[i + 1]!.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  if (positional === "") {
    return { error: "Provide a URL or file path. Usage: /wiki:ingest <URL|path> [--tags a,b,c]" };
  }
  const parsed = parseInput(positional);
  if (parsed.kind === "url") {
    return { input: { kind: "url", url: parsed.url, tags }, positional };
  }
  return { input: { kind: "file", path: parsed.path, tags }, positional };
}

export default function (pi: ExtensionAPI): void {
  // ── Tool registration ──────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description:
      "Ingest a URL or local file into the local llm-wiki hub at " +
      "<hub>/raw/articles/<slug>/source.md. Returns the written path and a " +
      "summary. Read the file back with read/grep to confirm.",
    parameters: Type.Object({
      source: Type.Union([Type.Literal("url"), Type.Literal("file")]),
      url: Type.Optional(Type.String({ description: "URL to fetch (when source: url)" })),
      path: Type.Optional(Type.String({ description: "Local file path (when source: file)" })),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Tags to add to frontmatter" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No llm-wiki hub found. Set `hub_path` in " +
                  "`~/.config/llm-wiki/config.json` or create `~/wiki/`.",
              },
            ],
            details: {},
            isError: true,
          };
        }
        if (params.source === "url" && !params.url) {
          return { content: [{ type: "text", text: "source=url requires `url` parameter." }], details: {}, isError: true };
        }
        if (params.source === "file" && !params.path) {
          return { content: [{ type: "text", text: "source=file requires `path` parameter." }], details: {}, isError: true };
        }
        const input: IngestInput =
          params.source === "url"
            ? { kind: "url", url: params.url!, tags: params.tags }
            : { kind: "file", path: params.path!, tags: params.tags };
        const result = await runIngest(hub, input);
        if (!result.ok) {
          return { content: [{ type: "text", text: `wiki_ingest: ${result.error}` }], details: {}, isError: true };
        }
        return { content: [{ type: "text", text: result.summary }], details: {} };
      } catch (err) {
        return {
          content: [{ type: "text", text: `wiki_ingest error: ${(err as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── Slash command ───────────────────────────────────────────────────
  pi.registerCommand("wiki:ingest", {
    description: "Ingest a URL or local file into the local llm-wiki hub",
    handler: async (args, ctx) => {
      const parsed = parseSlashArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const hub = resolveHubPath();
      if (!hub) {
        ctx.ui.notify("No llm-wiki hub found.", "error");
        return;
      }
      const result = await runIngest(hub, parsed.input);
      if (!result.ok) {
        ctx.ui.notify(result.error, "error");
        return;
      }
      ctx.ui.notify(result.summary, "info");
    },
  });
}
