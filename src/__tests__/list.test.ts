import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  listArticles,
  formatArticlesTable,
  showArticle,
} from "../list.js";

describe("parseFrontmatter", () => {
  it("parses a simple string value", () => {
    const md = '---\ntitle: "Hello"\n---\nbody';
    const { meta, body } = parseFrontmatter(md);
    expect(meta.title).toBe("Hello");
    expect(body).toBe("body");
  });

  it("parses a string array", () => {
    const md = '---\ntags:\n  - "a"\n  - "b"\n---\nbody';
    const { meta } = parseFrontmatter(md);
    expect(meta.tags).toEqual(["a", "b"]);
  });

  it("parses an empty array", () => {
    const md = '---\ntags: []\n---\nbody';
    const { meta } = parseFrontmatter(md);
    expect(meta.tags).toEqual([]);
  });

  it("handles missing frontmatter", () => {
    const { meta, body } = parseFrontmatter("just body");
    expect(meta).toEqual({});
    expect(body).toBe("just body");
  });

  it("handles unterminated frontmatter", () => {
    const { meta, body } = parseFrontmatter("---\ntitle: x\nno end");
    expect(meta).toEqual({});
    expect(body).toBe("---\ntitle: x\nno end");
  });
});

describe("listArticles", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-list-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty when no articles dir", () => {
    const r = listArticles(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.articles).toEqual([]);
  });

  it("lists articles with their frontmatter", () => {
    const slug1 = "aaaa1111bbbb";
    const slug2 = "cccc2222dddd";
    mkdirSync(join(tmp, "raw", "articles", slug1), { recursive: true });
    mkdirSync(join(tmp, "raw", "articles", slug2), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug1, "source.md"),
      '---\ntitle: "First"\nsource: "url"\ningested_at: "2026-07-21T00:00:00Z"\ntags:\n  - "x"\n---\nbody1',
    );
    writeFileSync(
      join(tmp, "raw", "articles", slug2, "source.md"),
      '---\ntitle: "Second"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags: []\n---\nbody2',
    );

    const r = listArticles(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.articles).toHaveLength(2);
    expect(r.articles[0]?.slug).toBe(slug1);
    expect(r.articles[0]?.title).toBe("First");
    expect(r.articles[0]?.tags).toEqual(["x"]);
    expect(r.articles[1]?.slug).toBe(slug2);
    expect(r.articles[1]?.tags).toEqual([]);
  });
});

describe("formatArticlesTable", () => {
  it("formats a markdown table", () => {
    const out = formatArticlesTable([
      {
        slug: "abc",
        title: "Test",
        source: "url",
        tags: ["x", "y"],
        ingestedAt: "2026-07-21T00:00:00Z",
      },
    ]);
    expect(out).toContain("| slug | title | source | tags | ingested_at |");
    expect(out).toContain("|------|-------|--------|------|--------------|");
    expect(out).toContain("`abc`");
    expect(out).toContain("Test");
    expect(out).toContain("`x`");
  });

  it("returns a friendly message when empty", () => {
    expect(formatArticlesTable([])).toContain("No ingested articles");
  });
});

describe("showArticle", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-show-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the full content of an existing slug", () => {
    const slug = "abcd1234efgh";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "x"\n---\nbody content',
    );
    const r = showArticle(tmp, slug);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain("title: \"x\"");
    expect(r.content).toContain("body content");
  });

  it("returns error for missing slug", () => {
    const r = showArticle(tmp, "nosuch");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No such article/);
  });

  it("rejects slugs with path traversal characters", () => {
    const r = showArticle(tmp, "../etc/passwd");
    expect(r.ok).toBe(false);
  });
});
