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
import { listArticles, formatArticlesTable, showArticle, rebuildRawIndex, readRawIndex, rebuildWikiIndex, readWikiIndex, formatWikiArticlesTable, listWikiArticles } from "./list.js";
import { runCompile, runCompileMulti, parseCompileMultiArgs } from "./compile.js";
import { runQuery } from "./query.js";
import { runLint, formatLintReport } from "./lint.js";
import { parseSearchArgs, buildSearchHint } from "./search.js";
import { runAdd, parseAddArgs } from "./add.js";
import { callLlm } from "./llm.js";
import { buildContextForPrompt } from "./context.js";

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
      force: Type.Optional(Type.Boolean({ description: "Overwrite an existing slug with different content" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        if (params.source === "url" && !params.url) return errResult("source=url requires `url`.");
        if (params.source === "file" && !params.path) return errResult("source=file requires `path`.");
        const input: IngestInput = params.source === "url"
          ? { kind: "url", url: params.url!, tags: params.tags, force: params.force }
          : { kind: "file", path: params.path!, tags: params.tags, force: params.force };
        const r = await runIngest(hub, input);
        if (r.ok) {
          const idx = rebuildRawIndex(hub);
          const suffix = idx.ok ? `\nIndex: ${idx.path} (${idx.count} articles)` : `\nIndex update failed: ${idx.error}`;
          return { content: [{ type: "text", text: r.summary + suffix }], details: {} };
        }
        return errResult(r.error);
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
      if (r.ok) {
        ctx.ui.notify(r.summary, "info");
        const idx = rebuildRawIndex(hub);
        if (idx.ok) ctx.ui.notify(`Index updated: ${idx.count} articles`, "info");
        else ctx.ui.notify(`Index update failed: ${idx.error}`, "warning");
      } else {
        ctx.ui.notify(r.error, "error");
      }
    },
  });

  // ── /wiki:ls (v0.2) ────────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_ls",
    label: "Wiki List",
    description: "List all ingested articles in the local llm-wiki hub as a markdown table.",
    parameters: Type.Object({
      tag: Type.Optional(Type.String({ description: "Filter by tag (case-insensitive)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        if (params.tag) {
          const r = listArticles(hub, params.tag);
          if (!r.ok) return errResult(r.error);
          return { content: [{ type: "text", text: formatArticlesTable(r.articles) }], details: {} };
        }
        const idx = readRawIndex(hub);
        if (idx.ok) return { content: [{ type: "text", text: idx.content }], details: {} };
        const r = listArticles(hub);
        if (!r.ok) return errResult(r.error);
        return { content: [{ type: "text", text: formatArticlesTable(r.articles) }], details: {} };
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:ls", {
    description: "List ingested articles (use --tag <name> to filter)",
    handler: async (args, ctx) => {
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      const tagMatch = /--tag[=\s]+(\S+)/.exec(args);
      const tag = tagMatch?.[1];
      if (tag) {
        const r = listArticles(hub, tag);
        if (!r.ok) return ctx.ui.notify(r.error, "error");
        return ctx.ui.notify(formatArticlesTable(r.articles), "info");
      }
      const idx = readRawIndex(hub);
      if (idx.ok) return ctx.ui.notify(idx.content, "info");
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
        const idx = rebuildRawIndex(hub);
        if (idx.ok) lines.push(`Raw index updated: ${idx.count} articles`);
        const widx = rebuildWikiIndex(hub);
        if (widx.ok) lines.push(`Wiki index updated: ${widx.count} articles`);
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
      const topic = parseTopicArg(args);
      ctx.ui.notify("Compiling…", "info");
      const caller = makeLlmCaller(ctx);
      const r = await runCompile(hub, { hub, topic }, caller);
      if (!r.ok) return ctx.ui.notify(r.error, "error");
      for (const c of r.compiled) {
        ctx.ui.notify(`Compiled ${c.slug} → ${c.wikiPath}`, "info");
      }
      const idx = rebuildRawIndex(hub);
      if (idx.ok) ctx.ui.notify(`Raw index updated: ${idx.count} articles`, "info");
      else ctx.ui.notify(`Raw index update failed: ${idx.error}`, "warning");
      const widx = rebuildWikiIndex(hub);
      if (widx.ok) ctx.ui.notify(`Wiki index updated: ${widx.count} articles`, "info");
      else ctx.ui.notify(`Wiki index update failed: ${widx.error}`, "warning");
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
      tag: Type.Optional(Type.String({ description: "Filter by tag (case-insensitive)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        const caller = makeLlmCaller(ctx);
        const r = await runQuery(
          { hub, query: params.query, maxMatches: params.max_matches, tag: params.tag },
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
    description: "Search the wiki and ask the current Pi model for an answer (use --tag <name> to filter)",
    handler: async (args, ctx) => {
      const tagMatch = /--tag[=\s]+(\S+)/.exec(args);
      const tag = tagMatch?.[1];
      const query = args.replace(/--tag[=\s]+\S+/g, "").trim();
      if (!query) return ctx.ui.notify("Usage: /wiki:query <text> [--tag <name>]", "warning");
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      ctx.ui.notify("Searching…", "info");
      const caller = makeLlmCaller(ctx);
      const r = await runQuery({ hub, query, tag }, caller);
      if (!r.ok) return ctx.ui.notify(r.error, "error");
      ctx.ui.notify(r.answer, "info");
    },
  });

  // ── /wiki:lint (v0.4) ──────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Run 5 lint/audit checks across raw/articles/ and wiki/: frontmatter, " +
      "broken wikilinks, empty files, duplicate content, tag normalization. " +
      "No LLM call. Returns a markdown report grouped by severity.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        const r = runLint(hub);
        if (!r.ok) return errResult(r.error);
        return { content: [{ type: "text", text: formatLintReport(r) }], details: {} };
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:lint", {
    description: "Run lint/audit checks on the local llm-wiki hub",
    handler: async (_args, ctx) => {
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      const r = runLint(hub);
      if (!r.ok) return ctx.ui.notify(r.error, "error");
      ctx.ui.notify(formatLintReport(r), r.summary.errors > 0 ? "error" : r.summary.warnings > 0 ? "warning" : "info");
    },
  });

  // ── /wiki:index (v0.4) ─────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_index",
    label: "Wiki Index",
    description:
      "Show or rebuild the wiki/<slug>/_index.md (compiled articles table). " +
      "Without --rebuild, reads the existing file. With --rebuild, regenerates " +
      "from disk.",
    parameters: Type.Object({
      rebuild: Type.Optional(Type.Boolean({ description: "Force rebuild from disk" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        if (params.rebuild) {
          const r = rebuildWikiIndex(hub);
          if (!r.ok) return errResult(r.error);
          return { content: [{ type: "text", text: r.path }], details: {} };
        }
        const idx = readWikiIndex(hub);
        if (idx.ok) return { content: [{ type: "text", text: idx.content }], details: {} };
        const r = listWikiArticles(hub);
        if (!r.ok) return errResult(r.error);
        return { content: [{ type: "text", text: formatWikiArticlesTable(r.articles) }], details: {} };
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:index", {
    description: "Show or rebuild wiki/_index.md (compiled articles table)",
    handler: async (args, ctx) => {
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      const wantRebuild = args.trim() === "--rebuild";
      if (wantRebuild) {
        const r = rebuildWikiIndex(hub);
        if (!r.ok) return ctx.ui.notify(r.error, "error");
        ctx.ui.notify(`Wiki index rebuilt: ${r.count} articles → ${r.path}`, "info");
        return;
      }
      const idx = readWikiIndex(hub);
      if (idx.ok) return ctx.ui.notify(idx.content, "info");
      const r = listWikiArticles(hub);
      if (!r.ok) return ctx.ui.notify(r.error, "error");
      ctx.ui.notify(formatWikiArticlesTable(r.articles), "info");
    },
  });

  // ── /wiki:search (v0.5) ────────────────────────────────────────────
  pi.registerCommand("wiki:search", {
    description: "Search the web via the LLM and ingest the top N URLs (uses WebSearch tool)",
    handler: async (args, ctx) => {
      const parsed = parseSearchArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const hint = buildSearchHint(parsed.request);
      ctx.ui.notify(
        `Searching for "${parsed.request.query}" (limit ${parsed.request.limit}, tag: ${hint.tag})…`,
        "info",
      );
      pi.sendUserMessage(hint.prompt, { deliverAs: "followUp" });
    },
  });

  // ── /wiki:add (v0.6) ───────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_add",
    label: "Wiki Add",
    description:
      "Ingest a source AND compile it into a wiki article in one call. " +
      "Equivalent to /wiki:ingest followed by /wiki:compile. " +
      "Set no_compile=true to skip the LLM step and only write the raw source.",
    parameters: Type.Object({
      source: Type.Union([Type.Literal("url"), Type.Literal("file")]),
      url: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      no_compile: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        if (params.source === "url" && !params.url) return errResult("source=url requires `url`.");
        if (params.source === "file" && !params.path) return errResult("source=file requires `path`.");
        const input: IngestInput = params.source === "url"
          ? { kind: "url", url: params.url!, tags: params.tags }
          : { kind: "file", path: params.path!, tags: params.tags };
        const caller = params.no_compile ? null : makeLlmCaller(ctx);
        const r = await runAdd(input, { hub, noCompile: params.no_compile }, caller);
        if (!r.ok) {
          return errResult(`${r.stage} failed: ${r.error}`);
        }
        const lines: string[] = [];
        lines.push(`Ingested → ${r.ingest.writtenPath}`);
        if (r.compile) {
          for (const c of r.compile.compiled) {
            lines.push(`Compiled  → ${c.wikiPath} (${c.bytesIn} → ${c.bytesOut} bytes)`);
          }
        } else {
          lines.push("Compile skipped (--no-compile or no model).");
        }
        const idx = rebuildRawIndex(hub);
        if (idx.ok) lines.push(`Raw index updated: ${idx.count} articles`);
        if (r.compile) {
          const widx = rebuildWikiIndex(hub);
          if (widx.ok) lines.push(`Wiki index updated: ${widx.count} articles`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:add", {
    description: "Ingest + compile in one command (URL or file path)",
    handler: async (args, ctx) => {
      const parsed = parseAddArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      ctx.ui.notify("Adding (ingest + compile)…", "info");
      const caller = parsed.noCompile ? null : makeLlmCaller(ctx);
      const r = await runAdd(parsed.input, { hub, noCompile: parsed.noCompile }, caller);
      if (!r.ok) {
        return ctx.ui.notify(`${r.stage} failed: ${r.error}`, "error");
      }
      ctx.ui.notify(`Ingested → ${r.ingest.writtenPath}`, "info");
      if (r.compile) {
        for (const c of r.compile.compiled) {
          ctx.ui.notify(`Compiled → ${c.wikiPath}`, "info");
        }
        const widx = rebuildWikiIndex(hub);
        if (widx.ok) ctx.ui.notify(`Wiki index updated: ${widx.count} articles`, "info");
      } else {
        ctx.ui.notify("Compile skipped.", "info");
      }
      const idx = rebuildRawIndex(hub);
      if (idx.ok) ctx.ui.notify(`Raw index updated: ${idx.count} articles`, "info");
    },
  });

  // ── /wiki:merge (v0.8) ─────────────────────────────────────────────
  pi.registerTool({
    name: "wiki_merge",
    label: "Wiki Merge",
    description:
      "Compile multiple raw sources into a single wiki article. " +
      "Uses the current Pi model to synthesize the inputs.",
    parameters: Type.Object({
      sources: Type.Array(Type.String(), { description: "Source slugs to merge" }),
      slug: Type.Optional(Type.String({ description: "Output wiki slug (default: merged-<timestamp>)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const hub = resolveHubPath();
        if (!hub) return errResult("No llm-wiki hub found.");
        if (params.sources.length === 0) return errResult("At least one source slug is required.");
        const caller = makeLlmCaller(ctx);
        const r = await runCompileMulti(
          { hub, sources: params.sources, slug: params.slug },
          caller,
        );
        if (!r.ok) return errResult(r.error);
        const lines: string[] = [];
        for (const c of r.compiled) {
          lines.push(`Merged ${c.sourceSlugs.length} sources → ${c.wikiPath} (${c.bytesIn} → ${c.bytesOut} bytes)`);
        }
        const widx = rebuildWikiIndex(hub);
        if (widx.ok) lines.push(`Wiki index updated: ${widx.count} articles`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });
  pi.registerCommand("wiki:merge", {
    description: "Merge multiple raw sources into one wiki article (--sources slug1,slug2 [--slug out])",
    handler: async (args, ctx) => {
      const parsed = parseCompileMultiArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const hub = resolveHubPath();
      if (!hub) return ctx.ui.notify("No llm-wiki hub found.", "error");
      ctx.ui.notify(`Merging ${parsed.sources.length} sources…`, "info");
      const caller = makeLlmCaller(ctx);
      const r = await runCompileMulti(
        { hub, sources: parsed.sources, slug: parsed.slug },
        caller,
      );
      if (!r.ok) return ctx.ui.notify(r.error, "error");
      for (const c of r.compiled) {
        ctx.ui.notify(`Merged → ${c.wikiPath}`, "info");
      }
      const widx = rebuildWikiIndex(hub);
      if (widx.ok) ctx.ui.notify(`Wiki index updated: ${widx.count} articles`, "info");
    },
  });

  // ── before_agent_start (v0.8) — auto-inject wiki context ──────────
  pi.on("before_agent_start", (event) => {
    const hub = resolveHubPath();
    if (!hub) return;
    const block = buildContextForPrompt(hub, event.prompt);
    if (!block) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + block };
  });
}

function errResult(message: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never>; isError: true } {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

function parseTopicArg(args: string): string | undefined {
  const m = /--topic(?:=|\s+)(\S+)/.exec(args);
  if (!m) return undefined;
  return m[1];
}
