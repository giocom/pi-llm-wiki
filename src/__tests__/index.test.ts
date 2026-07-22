import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rebuildRawIndex,
  readRawIndex,
  buildRawIndexContent,
  RAW_INDEX_FILENAME,
} from "../list.js";

describe("rebuildRawIndex", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-idx-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the index file when no articles exist", () => {
    const r = rebuildRawIndex(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(0);
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toBe(join(tmp, "raw", "articles", RAW_INDEX_FILENAME));
  });

  it("lists existing articles in the index", () => {
    const slug = "abcd1234efgh";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "My Note"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags:\n  - "x"\n---\nbody',
    );
    const r = rebuildRawIndex(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(1);
    const read = readRawIndex(tmp);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.content).toContain("type: index");
    expect(read.content).toContain("count: 1");
    expect(read.content).toContain("`abcd1234efgh`");
    expect(read.content).toContain("My Note");
  });

  it("is idempotent — re-running overwrites with the same data", () => {
    const slug = "idemp00000id";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "T"\ntags: []\ningested_at: "2026-07-22T00:00:00Z"\n---\nb',
    );
    const r1 = rebuildRawIndex(tmp);
    const r2 = rebuildRawIndex(tmp);
    expect(r1.ok && r2.ok).toBe(true);
  });

  it("handles a hub with a missing raw/ directory", () => {
    // No raw/ dir at all — should create it
    const r = rebuildRawIndex(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(existsSync(r.path)).toBe(true);
  });
});

describe("readRawIndex", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-idx-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns missing=true when the file does not exist", () => {
    const r = readRawIndex(tmp);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toBe(true);
  });

  it("returns the content when the file exists", () => {
    rebuildRawIndex(tmp);
    const r = readRawIndex(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content.length).toBeGreaterThan(0);
  });
});

describe("buildRawIndexContent", () => {
  it("includes frontmatter and a markdown table", () => {
    const out = buildRawIndexContent([
      {
        slug: "abc",
        title: "T",
        source: "url",
        tags: ["x"],
        ingestedAt: "2026-07-22T00:00:00Z",
      },
    ]);
    expect(out).toContain("type: index");
    expect(out).toContain("count: 1");
    expect(out).toContain("| slug |");
    expect(out).toContain("`abc`");
  });

  it("renders count: 0 for empty list", () => {
    const out = buildRawIndexContent([]);
    expect(out).toContain("count: 0");
    expect(out).toContain("No ingested articles");
  });
});
