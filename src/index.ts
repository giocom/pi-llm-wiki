/**
 * pi-llm-wiki v0.2 — extension shell.
 *
 * Five surfaces registered with Pi:
 *   - `/wiki:ingest` + `wiki_ingest` tool   (v0.1)
 *   - `/wiki:ls`     + `wiki_ls` tool       (v0.2 — list ingested articles)
 *   - `/wiki:show`   + `wiki_show` tool     (v0.2 — show one article)
 *   - `/wiki:compile` + `wiki_compile` tool (v0.2 — LLM-summarize raw → wiki/<slug>/)
 *   - `/wiki:query`  + `wiki_query` tool    (v0.2 — grep + LLM synthesis)
 *
 * Pure logic lives in `ingest.ts`, `list.ts`, `compile.ts`, `query.ts`.
 * LLM calls go through `llm.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runIngest, parseInput, type IngestInput } from "./ingest.js";
import { listArticles, formatArticlesTable, showArticle } from "./list.js";
import { runCompile } from "./compile.js";
import { runQuery } from "./query.js";
import { callLlm } from "./llm.js";

// ─── Hub resolution (inline for v0.2) ─────────────────────────────────

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

// ─── Ingest argument parsing (v0.1) ───────────────────────────────────

function parseIngestArgs(args: string): { input: IngestInput; positional: string } | { error: string } {
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
    } else if (tok === "--tags") continue;
    else if (positional === "" && !tok.startsWith("--")) {
      positional = tok;
    }
  }
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

// ─── LLM caller adapter (injects ctx.model) ───────────────────────────

type LlmCaller = (prompt: { system: string; user: string }) => Promise<{ text: string; modelId: string }>;

function makeLlmCaller(ctx: { modelRegistry: unknown; model: unknown }): LlmCaller {
  return async (prompt) => callLlm(
    ctx as Parameters<typeof callLlm>[0],
    { systemPrompt: prompt.system, userPrompt: prompt.user },
  );
}

// ─── Extension registration ──────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // ── /wiki:ingest (v0.1) ────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description:
      "Ingest a URL or local file into the local llm-wiki hub at " +
      "<hub>/raw/articles/<slug>/source.md. Returns the written path.",
    parameters: Type.Object({
      source: Type.Union([Type.Literal("url"), Type.Literal("file")]),
      url: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        if (params.source === "url" && !params.url) return errResult("source=url requires `url`.");
        if (params.source === "file" && !params.path) return errResult("source=file requires `path`.");
        const input: IngestInput = params.source === "url"
          ? { kind: "url", url: params.url!, tags: params.tags }
          : { kind: "file", path: params.path!, tags: params.tags };
        const r = await runIngest(hub, input);
        return r.ok
          ? { content: [{ type: "text", text: r.summary }], details: {} }
          : errResult(r.error);
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:ingest", {
    description: "Ingest a URL or local file into the local llm-wiki hub",
    handler: async (args, ctx) => {
      const parsed = parseIngestArgs(args);
      if ("error" in parsed) return ctx.ui.notify(parsed.error, "warning");
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      const r = await runIngest(hub, parsed.input);
      ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? "info" : "error");
    },
  });

  // ── /wiki:ls (v0.2) ────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_ls",
    label: "Wiki List",
    description: "List all ingested articles in the local llm-wiki hub as a markdown table.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        const r = listArticles(hub);
        if (!r.ok) return errResult(r.error);
        return { content: [{ type: "text", text: formatArticlesTable(r.articles) }], details: {} };
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:ls", {
    description: "List ingested articles",
    handler: async (_args, ctx) => {
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      const r = listArticles(hub);
      if (!r.ok) return ctx.ui.notify(r.error, "error");
      ctx.ui.notify(formatArticlesTable(r.articles), "info");
    },
  });

  // ── /wiki:show (v0.2) ──────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_show",
    label: "Wiki Show",
    description: "Show the full content (frontmatter + body) of one ingested article by slug.",
    parameters: Type.Object({
      slug: Type.String({ description: "Article slug (12 hex chars)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        const r = showArticle(hub, params.slug);
        return r.ok
          ? { content: [{ type: "text", text: r.content }], details: {} }
          : errResult(r.error);
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:show", {
    description: "Show one ingested article",
    handler: async (args, ctx) => {
      const slug = args.trim();
      if (!slug) return ctx.ui.notify("Usage: /wiki:show <slug>", "warning");
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      const r = showArticle(hub, slug);
      ctx.ui.notify(r.ok ? r.content : r.error, r.ok ? "info" : "error");
    },
  });

  // ── /wiki:compile (v0.2) ───────────────────────────────────────────
  pi.registerTool({
    name: "wiki_compile",
    label: "Wiki Compile",
    description:
      "Compile ingested articles into wiki/<slug>/index.md using the current Pi model. " +
      "Default: compile all slugs. Use --topic to compile one.",
    parameters: Type.Object({
      topic: Type.Optional(Type.String({ description: "Compile only this slug" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        const caller = makeLlmCaller(ctx);
        const r = await runCompile(hub, { hub, topic: params.topic }, caller);
        if (!r.ok) return errResult(r.error);
        const lines = r.compiled.map((c) => `Compiled ${c.slug} → ${c.wikiPath} (${c.bytesIn} → ${c.bytesOut} bytes)`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:compile", {
    description: "Compile ingested articles into wiki/<slug>/index.md (uses current Pi model)",
    handler: async (args, ctx) => {
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      const topic = args.trim() || undefined;
      ctx.ui.notify("Compiling…", "info");
      const caller = makeLlmCaller(ctx);
      const r = await runCompile(hub, { hub, topic }, caller);
      if (!r.ok) return ctx.ui.notify(r.error, "error");
      for (const c of r.compiled) {
        ctx.ui.notify(`Compiled ${c.slug} → ${c.wikiPath}`, "info");
      }
    },
  });

  // ── /wiki:query (v0.2) ─────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_query",
    label: "Wiki Query",
    description:
      "Search the wiki and ingested articles, then ask the current Pi model to " +
      "synthesize a one-paragraph answer with inline path:line citations.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
      max_matches: Type.Optional(Type.Number({ description: "Max grep matches (default 5)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        const caller = makeLlmCaller(ctx);
        const r = await runQuery(
          { hub, query: params.query, maxMatches: params.max_matches },
          caller,
        );
        if (!r.ok) return errResult(r.error);
        return { content: [{ type: "text", text: r.answer }], details: {} };
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:query", {
    description: "Search the wiki and ask the current Pi model for an answer",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("Usage: /wiki:query <text>", "warning");
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      ctx.ui.notify("Searching…", "info");
      const caller = makeLlmCaller(ctx);
      const r = await runQuery({ hub, query }, caller);
      if (!r.ok) return ctx.ui.notify(r.error, "error");
      ctx.ui.notify(r.answer, "info");
    },
  });
}

function errResult(message: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never>; isError: true } {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}
