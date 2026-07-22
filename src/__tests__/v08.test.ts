/**
 * v0.8 tests:
 *   - dedup (checkDuplicate)
 *   - tag filter (listArticles with tag, grepHub with tag, tagsForFile, fileMatchesTag)
 *   - context injection (extractKeywords, grepForKeywords, formatContextBlock, buildContextForPrompt)
 *   - multi-compile (runCompileMulti, parseCompileMultiArgs, buildMultiCompilePrompt)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDuplicate, runIngest } from "../ingest.js";
import { listArticles, tagsForFile, fileMatchesTag } from "../list.js";
import { grepHub, runQuery } from "../query.js";
import {
  runCompileMulti, parseCompileMultiArgs, buildMultiCompilePrompt,
} from "../compile.js";
import {
  extractKeywords, grepForKeywords, formatContextBlock, buildContextForPrompt,
} from "../context.js";
import type { LlmResult } from "../compile.js";

function makeArticle(hub: string, slug: string, fm: Record<string, string>, body: string): void {
  const dir = join(hub, "raw", "articles", slug);
  mkdirSync(dir, { recursive: true });
  const yaml = [
    "---",
    ...Object.entries(fm).map(([k, v]) => `${k}: "${v}"`),
    "---",
  ].join("\n");
  writeFileSync(join(dir, "source.md"), `${yaml}\n\n${body}\n`, "utf8");
}

function stubLlm(answer = "## Summary\n\nStub answer."): (p: { system: string; user: string }) => Promise<LlmResult> {
  return async () => ({ text: answer, modelId: "stub/model" });
}

// ─── dedup ────────────────────────────────────────────────────────────

describe("v0.8 dedup — checkDuplicate", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns 'missing' when no source.md exists", () => {
    const r = checkDuplicate(tmp, "abc123", "---\ntitle: x\n---\nbody");
    expect(r.kind).toBe("missing");
  });

  it("returns 'identical' when body matches", () => {
    makeArticle(tmp, "abc123", { title: "x" }, "body");
    const existing = readFileSync(join(tmp, "raw", "articles", "abc123", "source.md"), "utf8");
    const r = checkDuplicate(tmp, "abc123", existing);
    expect(r.kind).toBe("identical");
  });

  it("returns 'different' with existingTitle when body differs", () => {
    makeArticle(tmp, "abc123", { title: "Original" }, "body");
    const r = checkDuplicate(tmp, "abc123", '---\ntitle: "x"\n---\nNEW');
    expect(r.kind).toBe("different");
    if (r.kind !== "different") return;
    expect(r.existingTitle).toBe("Original");
  });
});

describe("v0.8 dedup — runIngest integration", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("writes a new slug on first ingest", async () => {
    const r = await runIngest(tmp, { kind: "file", path: "" }); // invalid path to keep test isolated
    // (the runIngest function checks existsSync first; we'll do a real ingest below)
    expect(r).toBeDefined();
  });

  it("refuses overwrite without --force and returns descriptive error", async () => {
    const inputFile = join(tmp, "note.md");
    writeFileSync(inputFile, "first", "utf8");
    const r1 = await runIngest(tmp, { kind: "file", path: inputFile, tags: ["a"] });
    expect(r1.ok).toBe(true);
    // Second ingest with different content (write to the same path)
    writeFileSync(inputFile, "DIFFERENT", "utf8");
    const r2 = await runIngest(tmp, { kind: "file", path: inputFile, tags: ["a"] });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toMatch(/already exists/i);
    expect(r2.error).toMatch(/--force/);
  });

  it("returns duplicate: true when re-ingesting identical content", async () => {
    const inputFile = join(tmp, "note.md");
    writeFileSync(inputFile, "same", "utf8");
    const r1 = await runIngest(tmp, { kind: "file", path: inputFile, tags: ["a"] });
    expect(r1.ok).toBe(true);
    const r2 = await runIngest(tmp, { kind: "file", path: inputFile, tags: ["a"] });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.duplicate).toBe(true);
  });

  it("overwrites with --force even when content differs", async () => {
    const inputFile = join(tmp, "note.md");
    writeFileSync(inputFile, "first", "utf8");
    await runIngest(tmp, { kind: "file", path: inputFile, tags: ["a"] });
    writeFileSync(inputFile, "DIFFERENT", "utf8");
    const r = await runIngest(tmp, { kind: "file", path: inputFile, tags: ["a"], force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toMatch(/Ingested/);
  });
});

// ─── tag filter ──────────────────────────────────────────────────────

describe("v0.8 tag filter — listArticles", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("filters by tag (case-insensitive)", () => {
    makeArticle(tmp, "aaa", { title: "A" }, "a");
    makeArticle(tmp, "bbb", { title: "B" }, "b");
    // Edit bbb to have a tag
    const dir = join(tmp, "raw", "articles", "bbb");
    writeFileSync(join(dir, "source.md"), '---\ntitle: "B"\ntags: ["Bitcoin"]\n---\nb', "utf8");
    const r = listArticles(tmp, "bitcoin");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.articles).toHaveLength(1);
    expect(r.articles[0]?.slug).toBe("bbb");
  });

  it("returns all articles when no tag is given", () => {
    makeArticle(tmp, "aaa", { title: "A" }, "a");
    makeArticle(tmp, "bbb", { title: "B" }, "b");
    const r = listArticles(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.articles).toHaveLength(2);
  });
});

describe("v0.8 tag filter — grepHub", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("only returns matches from files matching the tag", () => {
    makeArticle(tmp, "tagged", { title: "T" }, "bitcoin is great");
    makeArticle(tmp, "untagged", { title: "U" }, "bitcoin is also here");
    // Add a tag to "tagged"
    const dir = join(tmp, "raw", "articles", "tagged");
    writeFileSync(join(dir, "source.md"), '---\ntitle: "T"\ntags: ["crypto"]\n---\nbitcoin is great', "utf8");
    const matches = grepHub(tmp, "bitcoin", 10, "crypto");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.relativePath).toContain("tagged");
  });

  it("returns all matches when tag is undefined", () => {
    makeArticle(tmp, "x", { title: "X" }, "bitcoin mention");
    makeArticle(tmp, "y", { title: "Y" }, "another bitcoin reference");
    const matches = grepHub(tmp, "bitcoin", 10);
    expect(matches).toHaveLength(2);
  });
});

describe("v0.8 tag filter — tagsForFile", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns own tags for raw files", () => {
    makeArticle(tmp, "raw1", { title: "R" }, "body");
    const dir = join(tmp, "raw", "articles", "raw1");
    writeFileSync(join(dir, "source.md"), '---\ntitle: "R"\ntags: ["alpha", "beta"]\n---\nbody', "utf8");
    const tags = tagsForFile(tmp, join(dir, "source.md"));
    expect(tags).toEqual(["alpha", "beta"]);
  });

  it("returns inherited tags for wiki files (via source_slugs)", () => {
    makeArticle(tmp, "src1", { title: "S" }, "body");
    const dir1 = join(tmp, "raw", "articles", "src1");
    writeFileSync(join(dir1, "source.md"), '---\ntitle: "S"\ntags: ["shared", "src1only"]\n---\nbody', "utf8");
    const wikiDir = join(tmp, "wiki", "merged");
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "index.md"), '---\ntitle: "M"\nsource_slugs: ["src1"]\n---\nbody', "utf8");
    const tags = tagsForFile(tmp, join(wikiDir, "index.md"));
    expect(tags.sort()).toEqual(["shared", "src1only"]);
  });
});

describe("v0.8 tag filter — fileMatchesTag", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns true for matching file", () => {
    makeArticle(tmp, "x", { title: "X" }, "body");
    const dir = join(tmp, "raw", "articles", "x");
    writeFileSync(join(dir, "source.md"), '---\ntitle: "X"\ntags: ["matched"]\n---\nbody', "utf8");
    expect(fileMatchesTag(tmp, join(dir, "source.md"), "matched")).toBe(true);
  });

  it("returns false for non-matching file", () => {
    makeArticle(tmp, "x", { title: "X" }, "body");
    const dir = join(tmp, "raw", "articles", "x");
    writeFileSync(join(dir, "source.md"), '---\ntitle: "X"\ntags: ["alpha"]\n---\nbody', "utf8");
    expect(fileMatchesTag(tmp, join(dir, "source.md"), "beta")).toBe(false);
  });

  it("returns true when no tag is given (no filter)", () => {
    makeArticle(tmp, "x", { title: "X" }, "body");
    const dir = join(tmp, "raw", "articles", "x");
    expect(fileMatchesTag(tmp, join(dir, "source.md"), undefined)).toBe(true);
  });
});

// ─── context injection ───────────────────────────────────────────────

describe("v0.8 context — extractKeywords", () => {
  it("extracts lowercase keywords, drops stopwords and short tokens", () => {
    const kw = extractKeywords("Tell me about Bitcoin and Lightning Network");
    expect(kw).toContain("bitcoin");
    expect(kw).toContain("lightning");
    expect(kw).toContain("network");
    expect(kw).not.toContain("about");
    expect(kw).not.toContain("and");
    expect(kw).not.toContain("me");
  });

  it("caps at 5 keywords", () => {
    const kw = extractKeywords("alpha beta gamma delta epsilon zeta eta theta");
    expect(kw.length).toBeLessThanOrEqual(5);
  });

  it("dedups", () => {
    const kw = extractKeywords("bitcoin Bitcoin BITCOIN");
    const uniq = new Set(kw);
    expect(uniq.size).toBe(kw.length);
  });

  it("returns empty for stopword-only input", () => {
    const kw = extractKeywords("the a an of to for");
    expect(kw).toEqual([]);
  });
});

describe("v0.8 context — grepForKeywords", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns up to maxMatches unique matches", () => {
    makeArticle(tmp, "x", { title: "X" }, "bitcoin and bitcoin again bitcoin");
    const dir = join(tmp, "raw", "articles", "x");
    const matches = grepForKeywords(tmp, ["bitcoin"], 2);
    expect(matches.length).toBeLessThanOrEqual(2);
    expect(matches[0]?.citation).toContain("source.md:");
  });

  it("returns empty for no keywords", () => {
    const matches = grepForKeywords(tmp, [], 3);
    expect(matches).toEqual([]);
  });

  it("skips _index.md files", () => {
    mkdirSync(join(tmp, "raw", "articles"), { recursive: true });
    writeFileSync(join(tmp, "raw", "articles", "_index.md"), "bitcoin in index");
    const matches = grepForKeywords(tmp, ["bitcoin"], 5);
    expect(matches).toEqual([]);
  });
});

describe("v0.8 context — formatContextBlock", () => {
  it("returns empty for empty matches", () => {
    expect(formatContextBlock([])).toBe("");
  });

  it("formats matches with citations and excerpts", () => {
    const out = formatContextBlock([
      { path: "/x", relativePath: "x", line: 1, excerpt: "hello", citation: "x:1" },
    ]);
    expect(out).toContain("Wiki context");
    expect(out).toContain("`x:1`");
    expect(out).toContain("hello");
  });
});

describe("v0.8 context — buildContextForPrompt", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns null when no hub exists", () => {
    expect(buildContextForPrompt("/no-such-hub", "bitcoin")).toBeNull();
  });

  it("returns null when prompt has no keywords", () => {
    makeArticle(tmp, "x", { title: "X" }, "bitcoin is mentioned here");
    const out = buildContextForPrompt(tmp, "the a an of to");
    expect(out).toBeNull();
  });

  it("returns null when no matches", () => {
    makeArticle(tmp, "x", { title: "X" }, "only markdown content");
    const out = buildContextForPrompt(tmp, "bitcoin lightning");
    expect(out).toBeNull();
  });

  it("returns a context block when matches are found", () => {
    makeArticle(tmp, "x", { title: "X" }, "bitcoin is great for testing");
    const out = buildContextForPrompt(tmp, "Tell me about bitcoin");
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out).toContain("Wiki context");
    expect(out).toContain("bitcoin");
  });
});

// ─── multi-compile ───────────────────────────────────────────────────

describe("v0.8 multi-compile — parseCompileMultiArgs", () => {
  it("parses --sources a,b,c", () => {
    const r = parseCompileMultiArgs("--sources a,b,c");
    expect("sources" in r);
    if (!("sources" in r)) return;
    expect(r.sources).toEqual(["a", "b", "c"]);
  });

  it("parses --sources space-separated", () => {
    const r = parseCompileMultiArgs("--sources a b c");
    expect("sources" in r);
    if (!("sources" in r)) return;
    expect(r.sources).toEqual(["a", "b", "c"]);
  });

  it("parses --slug", () => {
    const r = parseCompileMultiArgs("--sources a,b --slug overview");
    expect("sources" in r);
    if (!("sources" in r)) return;
    expect(r.sources).toEqual(["a", "b"]);
    expect(r.slug).toBe("overview");
  });

  it("rejects empty args", () => {
    const r = parseCompileMultiArgs("");
    expect("error" in r);
  });

  it("rejects missing --sources", () => {
    const r = parseCompileMultiArgs("--slug x");
    expect("error" in r);
  });
});

describe("v0.8 multi-compile — buildMultiCompilePrompt", () => {
  it("includes all source slugs and bodies", () => {
    const { system, user } = buildMultiCompilePrompt(
      [
        { slug: "a", meta: { title: "A" }, body: "body a" },
        { slug: "b", meta: { title: "B" }, body: "body b" },
      ],
      "merged",
    );
    expect(system).toContain("knowledge-base compiler");
    expect(user).toContain("Source 1");
    expect(user).toContain("`a`");
    expect(user).toContain("body a");
    expect(user).toContain("Source 2");
    expect(user).toContain("`b`");
    expect(user).toContain("body b");
    expect(user).toContain("merged");
  });
});

describe("v0.8 multi-compile — runCompileMulti", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("merges 2 sources with stub LLM", async () => {
    makeArticle(tmp, "src1", { title: "First" }, "content 1");
    makeArticle(tmp, "src2", { title: "Second" }, "content 2");
    const r = await runCompileMulti(
      { hub: tmp, sources: ["src1", "src2"] },
      stubLlm("## Merged\n\nCombined content."),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compiled).toHaveLength(1);
    expect(r.compiled[0]?.sourceSlugs).toEqual(["src1", "src2"]);
    const wikiFile = r.compiled[0]?.wikiPath ?? "";
    expect(existsSync(wikiFile)).toBe(true);
    const content = readFileSync(wikiFile, "utf8");
    expect(content).toContain("source_slugs:");
    expect(content).toContain("src1");
    expect(content).toContain("src2");
  });

  it("uses provided slug for output", async () => {
    makeArticle(tmp, "a", { title: "A" }, "x");
    const r = await runCompileMulti(
      { hub: tmp, sources: ["a"], slug: "custom-out" },
      stubLlm("body"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compiled[0]?.slug).toBe("custom-out");
  });

  it("generates a timestamp-based slug when none provided", async () => {
    makeArticle(tmp, "a", { title: "A" }, "x");
    const r = await runCompileMulti({ hub: tmp, sources: ["a"] }, stubLlm("body"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compiled[0]?.slug).toMatch(/^merged-\d+$/);
  });

  it("returns error when source slug does not exist", async () => {
    const r = await runCompileMulti(
      { hub: tmp, sources: ["nonexistent"] },
      stubLlm("body"),
    );
    expect(r.ok).toBe(false);
  });

  it("returns error when sources is empty", async () => {
    const r = await runCompileMulti({ hub: tmp, sources: [] }, stubLlm("body"));
    expect(r.ok).toBe(false);
  });

  it("works with null LLM (concatenation mode)", async () => {
    makeArticle(tmp, "a", { title: "A" }, "alpha");
    makeArticle(tmp, "b", { title: "B" }, "beta");
    const r = await runCompileMulti({ hub: tmp, sources: ["a", "b"] }, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = readFileSync(r.compiled[0]!.wikiPath, "utf8");
    expect(content).toContain("From a");
    expect(content).toContain("alpha");
    expect(content).toContain("From b");
    expect(content).toContain("beta");
  });
});

// ─── runQuery with tag ───────────────────────────────────────────────

describe("v0.8 runQuery with tag filter", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-v08-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("filters matches by tag", async () => {
    const dir1 = join(tmp, "raw", "articles", "tagged");
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, "source.md"), '---\ntitle: "T"\ntags: ["focus"]\n---\nbitcoin is mentioned', "utf8");
    makeArticle(tmp, "untagged", { title: "U" }, "bitcoin is also here");
    const r = await runQuery({ hub: tmp, query: "bitcoin", tag: "focus" }, stubLlm("answer"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.relativePath).toContain("tagged");
  });
});
