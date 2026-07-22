import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuery, grepIndexes, formatMatchTable, grepHub } from "../query.js";

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

describe("v0.15 — grepIndexes (quick mode)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-q-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("only scans the two _index.md files", () => {
    mkdirSync(join(tmp, "raw", "articles"), { recursive: true });
    mkdirSync(join(tmp, "wiki"), { recursive: true });
    writeFileSync(join(tmp, "raw", "articles", "_index.md"), "bitcoin mentioned in raw index\n");
    writeFileSync(join(tmp, "wiki", "_index.md"), "bitcoin mentioned in wiki index\n");
    mkdirSync(join(tmp, "raw", "articles", "aa11"), { recursive: true });
    writeFileSync(join(tmp, "raw", "articles", "aa11", "source.md"), "bitcoin in body, not in index\n");

    const matches = grepIndexes(tmp, "bitcoin");
    expect(matches).toHaveLength(2);
    const paths = matches.map((m) => m.relativePath).sort();
    expect(paths).toContain("raw/articles/_index.md");
    expect(paths).toContain("wiki/_index.md");
  });

  it("returns empty when no index files exist", () => {
    const matches = grepIndexes(tmp, "anything");
    expect(matches).toEqual([]);
  });
});

describe("v0.15 — formatMatchTable (--list mode)", () => {
  it("renders a markdown table", () => {
    const out = formatMatchTable([
      { path: "/x", relativePath: "x", line: 1, excerpt: "hello", citation: "x:1" },
    ]);
    expect(out).toContain("| citation | excerpt |");
    expect(out).toContain("`x:1`");
  });

  it("returns friendly message when empty", () => {
    expect(formatMatchTable([])).toBe("No matches.");
  });

  it("truncates long excerpts at 200 chars", () => {
    const long = "a".repeat(300);
    const out = formatMatchTable([
      { path: "/x", relativePath: "x", line: 1, excerpt: long, citation: "x:1" },
    ]);
    expect(out).toContain("a".repeat(200));
    expect(out).not.toContain("a".repeat(201));
  });

  it("escapes pipe characters in excerpts", () => {
    const out = formatMatchTable([
      { path: "/x", relativePath: "x", line: 1, excerpt: "a | b", citation: "x:1" },
    ]);
    expect(out).toContain("a \\| b");
  });
});

describe("v0.15 — runQuery depth option", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-qd-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("depth=list returns a markdown table and skips the LLM caller", async () => {
    makeArticle(tmp, "a", { title: "A" }, "bitcoin mention");
    let llmCalled = false;
    const stubLlm = async () => { llmCalled = true; return { text: "should not happen", modelId: "stub" }; };
    const r = await runQuery({ hub: tmp, query: "bitcoin", depth: "list" }, stubLlm);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(llmCalled).toBe(false);
    expect(r.usedLlm).toBe(false);
    expect(r.answer).toContain("bitcoin");
  });

  it("depth=quick uses grepIndexes and skips the LLM", async () => {
    mkdirSync(join(tmp, "raw", "articles"), { recursive: true });
    writeFileSync(join(tmp, "raw", "articles", "_index.md"), "bitcoin in raw index\n");
    let llmCalled = false;
    const stubLlm = async () => { llmCalled = true; return { text: "x", modelId: "stub" }; };
    const r = await runQuery({ hub: tmp, query: "bitcoin", depth: "quick" }, stubLlm);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(llmCalled).toBe(false);
    expect(r.usedLlm).toBe(false);
  });

  it("depth=deep (default) calls the LLM", async () => {
    makeArticle(tmp, "a", { title: "A" }, "bitcoin mention");
    const stubLlm = async () => ({ text: "stub answer", modelId: "stub" });
    const r = await runQuery({ hub: tmp, query: "bitcoin" }, stubLlm);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usedLlm).toBe(true);
  });
});
