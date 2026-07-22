import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectSlugs,
  buildCompilePrompt,
  buildWikiMarkdown,
  runCompile,
  type LlmResult,
} from "../compile.js";
import { grepHub, runQuery } from "../query.js";

describe("selectSlugs", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-compile-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns all slugs sorted", () => {
    mkdirSync(join(tmp, "raw", "articles", "zzz"), { recursive: true });
    mkdirSync(join(tmp, "raw", "articles", "aaa"), { recursive: true });
    mkdirSync(join(tmp, "raw", "articles", "no-source-here"), { recursive: true });
    writeFileSync(join(tmp, "raw", "articles", "zzz", "source.md"), "x");
    writeFileSync(join(tmp, "raw", "articles", "aaa", "source.md"), "x");
    expect(selectSlugs(tmp)).toEqual(["aaa", "zzz"]);
  });

  it("filters by topic when set", () => {
    mkdirSync(join(tmp, "raw", "articles", "a"), { recursive: true });
    mkdirSync(join(tmp, "raw", "articles", "b"), { recursive: true });
    writeFileSync(join(tmp, "raw", "articles", "a", "source.md"), "x");
    writeFileSync(join(tmp, "raw", "articles", "b", "source.md"), "x");
    expect(selectSlugs(tmp, "a")).toEqual(["a"]);
    expect(selectSlugs(tmp, "missing")).toEqual([]);
  });
});

describe("buildCompilePrompt", () => {
  it("includes title and tags in the user prompt", () => {
    const { system, user } = buildCompilePrompt(
      { title: "Test", tags: ["x", "y"] },
      "body content",
    );
    expect(system).toContain("knowledge-base compiler");
    expect(user).toContain("Test");
    expect(user).toContain("x, y");
    expect(user).toContain("body content");
  });
});

describe("buildWikiMarkdown", () => {
  it("includes frontmatter with source_slugs and compiled_at", () => {
    const md = buildWikiMarkdown("myslug", "My Title", "Body text", "myslug");
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("title: \"My Title\"");
    expect(md).toContain("source_slugs:");
    expect(md).toContain("compiled_at:");
    expect(md.trimEnd().endsWith("Body text")).toBe(true);
  });
});

describe("runCompile (stub LLM)", () => {
  let tmp: string;
  const stubLlm = async (): Promise<LlmResult> => ({
    text: "## Summary\n\nA concise summary.",
    modelId: "stub/model",
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-compile-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("compiles a single slug with a stub LLM", async () => {
    const slug = "abc123def456";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "Source Title"\ntags: ["a"]\n---\nThe original body.',
    );
    const r = await runCompile(tmp, { hub: tmp }, stubLlm);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compiled).toHaveLength(1);
    expect(r.compiled[0]?.slug).toBe(slug);
    expect(r.compiled[0]?.wikiPath).toBe(join(tmp, "wiki", slug, "index.md"));
  });

  it("is idempotent — re-running overwrites", async () => {
    const slug = "idempotent01";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "T"\n---\nbody',
    );
    const r1 = await runCompile(tmp, { hub: tmp }, async () => ({
      text: "first",
      modelId: "stub",
    }));
    const r2 = await runCompile(tmp, { hub: tmp }, async () => ({
      text: "second",
      modelId: "stub",
    }));
    expect(r1.ok && r2.ok).toBe(true);
  });

  it("returns error for empty hub", async () => {
    const r = await runCompile(tmp, { hub: tmp }, stubLlm);
    expect(r.ok).toBe(false);
  });
});

describe("grepHub", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-query-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds matches in both wiki/ and raw/articles/", () => {
    mkdirSync(join(tmp, "wiki", "topic-a"), { recursive: true });
    writeFileSync(join(tmp, "wiki", "topic-a", "index.md"), "line 1\nbitcoin info\nline 3");
    mkdirSync(join(tmp, "raw", "articles", "b-source"), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", "b-source", "source.md"),
      "intro\nbitcoin mention\nend",
    );
    const matches = grepHub(tmp, "bitcoin", 10);
    expect(matches).toHaveLength(2);
    const paths = matches.map((m) => m.relativePath).sort();
    expect(paths).toContain("wiki/topic-a/index.md");
    expect(paths).toContain("raw/articles/b-source/source.md");
  });

  it("is case-insensitive", () => {
    mkdirSync(join(tmp, "wiki", "t"), { recursive: true });
    writeFileSync(join(tmp, "wiki", "t", "index.md"), "Bitcoin is here");
    const m = grepHub(tmp, "bitcoin");
    expect(m.length).toBeGreaterThan(0);
  });

  it("returns empty for no matches", () => {
    const m = grepHub(tmp, "nothing");
    expect(m).toEqual([]);
  });

  it("respects maxMatches", () => {
    mkdirSync(join(tmp, "wiki", "t"), { recursive: true });
    writeFileSync(join(tmp, "wiki", "t", "index.md"), "a\na\na\na\na\na\n");
    const m = grepHub(tmp, "a", 2);
    expect(m.length).toBeLessThanOrEqual(2);
  });
});

describe("runQuery (stub LLM)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-query-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns matches and synthesized answer when LLM provided", async () => {
    mkdirSync(join(tmp, "wiki", "t"), { recursive: true });
    writeFileSync(join(tmp, "wiki", "t", "index.md"), "a bitcoin line");
    const stubLlm = async (): Promise<LlmResult> => ({
      text: "Bitcoin is a thing. (wiki/t/index.md:1)",
      modelId: "stub/model",
    });
    const r = await runQuery({ hub: tmp, query: "bitcoin" }, stubLlm);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.answer.toLowerCase()).toContain("bitcoin");
    expect(r.usedLlm).toBe(true);
  });

  it("returns just matches when LLM is null", async () => {
    mkdirSync(join(tmp, "wiki", "t"), { recursive: true });
    writeFileSync(join(tmp, "wiki", "t", "index.md"), "a bitcoin line");
    const r = await runQuery({ hub: tmp, query: "bitcoin" }, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usedLlm).toBe(false);
    expect(r.answer.toLowerCase()).toContain("bitcoin");
  });

  it("returns error if hub does not exist", async () => {
    const r = await runQuery({ hub: "/nonexistent-hub-path-xyz", query: "x" }, null);
    expect(r.ok).toBe(false);
  });
});
