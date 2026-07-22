import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWikiArticles,
  formatWikiArticlesTable,
  buildWikiIndexContent,
  rebuildWikiIndex,
  readWikiIndex,
  WIKI_INDEX_FILENAME,
} from "../list.js";

describe("listWikiArticles", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-widx-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty when wiki/ does not exist", () => {
    const r = listWikiArticles(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.articles).toEqual([]);
  });

  it("lists wiki articles with frontmatter", () => {
    const slug = "wabc1234wabc";
    mkdirSync(join(tmp, "wiki", slug), { recursive: true });
    writeFileSync(
      join(tmp, "wiki", slug, "index.md"),
      '---\ntitle: "Wiki Title"\nsource_slugs:\n  - "raw1"\n  - "raw2"\ncompiled_at: "2026-07-22T00:00:00Z"\n---\nbody',
    );
    const r = listWikiArticles(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.articles).toHaveLength(1);
    expect(r.articles[0]?.slug).toBe(slug);
    expect(r.articles[0]?.title).toBe("Wiki Title");
    expect(r.articles[0]?.sourceSlugs).toEqual(["raw1", "raw2"]);
  });
});

describe("formatWikiArticlesTable", () => {
  it("formats a table", () => {
    const out = formatWikiArticlesTable([
      { slug: "x", title: "T", sourceSlugs: ["a"], compiledAt: "2026-07-22T00:00:00Z" },
    ]);
    expect(out).toContain("| slug | title | source_slugs | compiled_at |");
    expect(out).toContain("`x`");
  });

  it("renders friendly empty", () => {
    expect(formatWikiArticlesTable([])).toContain("No compiled wiki");
  });
});

describe("rebuildWikiIndex / readWikiIndex", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-widx-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the index even when wiki/ is empty", () => {
    const r = rebuildWikiIndex(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe(join(tmp, "wiki", WIKI_INDEX_FILENAME));
    expect(existsSync(r.path)).toBe(true);
  });

  it("lists existing articles", () => {
    const slug = "widx00000001";
    mkdirSync(join(tmp, "wiki", slug), { recursive: true });
    writeFileSync(
      join(tmp, "wiki", slug, "index.md"),
      '---\ntitle: "T"\nsource_slugs: []\ncompiled_at: "2026-07-22T00:00:00Z"\n---\nbody',
    );
    const r = rebuildWikiIndex(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(1);
    const read = readWikiIndex(tmp);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.content).toContain("type: index");
    expect(read.content).toContain("`widx00000001`");
  });

  it("readWikiIndex returns missing=true when absent", () => {
    const r = readWikiIndex(tmp);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toBe(true);
  });
});

describe("buildWikiIndexContent", () => {
  it("includes frontmatter and table", () => {
    const out = buildWikiIndexContent([
      { slug: "a", title: "T", sourceSlugs: [], compiledAt: "" },
    ]);
    expect(out).toContain("type: index");
    expect(out).toContain("count: 1");
    expect(out).toContain("| slug |");
  });
});
