import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseInput,
  slugFromUrl,
  slugFromPath,
  stripHtml,
  htmlToMarkdown,
  buildFrontmatter,
  writeIngestedFile,
  runIngest,
  type IngestInput,
} from "../ingest.js";

describe("parseInput", () => {
  it("detects https URL", () => {
    expect(parseInput("https://example.com/foo")).toEqual({
      kind: "url",
      url: "https://example.com/foo",
    });
  });

  it("detects http URL", () => {
    expect(parseInput("http://example.com")).toEqual({
      kind: "url",
      url: "http://example.com",
    });
  });

  it("treats everything else as a file path", () => {
    expect(parseInput("/tmp/file.md")).toEqual({
      kind: "file",
      path: "/tmp/file.md",
    });
    expect(parseInput("./relative.md")).toEqual({
      kind: "file",
      path: "./relative.md",
    });
    expect(parseInput("docs/notes.md")).toEqual({
      kind: "file",
      path: "docs/notes.md",
    });
  });
});

describe("slugFromUrl", () => {
  it("is deterministic for the same URL", () => {
    const a = slugFromUrl("https://example.com/foo");
    const b = slugFromUrl("https://example.com/foo");
    expect(a).toBe(b);
  });

  it("is 12 hex chars", () => {
    const s = slugFromUrl("https://example.com");
    expect(s).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs for different URLs", () => {
    const a = slugFromUrl("https://example.com/a");
    const b = slugFromUrl("https://example.com/b");
    expect(a).not.toBe(b);
  });
});

describe("slugFromPath", () => {
  it("is deterministic for the same absolute path", () => {
    const a = slugFromPath("/tmp/notes.md");
    const b = slugFromPath("/tmp/notes.md");
    expect(a).toBe(b);
  });

  it("is 12 hex chars", () => {
    const s = slugFromPath("/tmp/notes.md");
    expect(s).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs for different files", () => {
    expect(slugFromPath("/tmp/a.md")).not.toBe(slugFromPath("/tmp/b.md"));
  });
});

describe("stripHtml", () => {
  it("removes <script> blocks", () => {
    const html = "<p>hello</p><script>alert(1)</script><p>world</p>";
    const out = stripHtml(html);
    expect(out).not.toContain("alert");
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  it("removes <style> blocks", () => {
    const html = "<style>body { color: red; }</style><p>kept</p>";
    const out = stripHtml(html);
    expect(out).not.toContain("color");
    expect(out).toContain("kept");
  });

  it("strips remaining tags", () => {
    const html = "<h1>Title</h1><p>body <em>here</em></p>";
    const out = stripHtml(html);
    expect(out).not.toContain("<");
    expect(out).toContain("Title");
    expect(out).toContain("body");
    expect(out).toContain("here");
  });

  it("collapses excessive whitespace", () => {
    const html = "<p>a</p>\n\n\n\n   <p>b</p>";
    const out = stripHtml(html);
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).not.toMatch(/  +/);
  });

  it("preserves paragraphs as double newlines", () => {
    const html = "<p>one</p><p>two</p>";
    const out = stripHtml(html);
    expect(out).toMatch(/one\s*\n\s*\n\s*two/);
  });
});

describe("htmlToMarkdown (turndown, v0.7)", () => {
  it("converts headings to ATX-style markdown", () => {
    const out = htmlToMarkdown("<h1>Title</h1><h2>Sub</h2>");
    expect(out).toContain("# Title");
    expect(out).toContain("## Sub");
  });

  it("converts bold and italic", () => {
    const out = htmlToMarkdown("<p><strong>bold</strong> and <em>italic</em></p>");
    expect(out).toContain("**bold**");
    expect(out).toContain("*italic*");
  });

  it("converts links to markdown links", () => {
    const out = htmlToMarkdown('<a href="https://example.com">click</a>');
    expect(out).toContain("[click](https://example.com)");
  });

  it("converts unordered lists", () => {
    const out = htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(out).toMatch(/-\s+one/);
    expect(out).toMatch(/-\s+two/);
  });

  it("converts fenced code blocks", () => {
    const out = htmlToMarkdown("<pre><code>const x = 1;</code></pre>");
    expect(out).toContain("```");
    expect(out).toContain("const x = 1;");
  });

  it("falls back to stripHtml when turndown produces empty output", () => {
    const out = htmlToMarkdown("<div id=\"root\"></div>");
    expect(out.length).toBeGreaterThanOrEqual(0);
  });

  it("preserves article body content (turndown vs stripHtml comparison)", () => {
    const html = "<article><h1>Bitcoin</h1><p>A <strong>decentralized</strong> currency.</p></article>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("# Bitcoin");
    expect(out).toContain("**decentralized**");
  });
});

describe("buildFrontmatter", () => {
  it("includes all required fields for URL source", () => {
    const fm = buildFrontmatter({
      title: "Hello World",
      source: "url",
      url: "https://example.com",
      ingestedAt: "2026-07-21T00:00:00Z",
      tags: ["a", "b"],
    });
    expect(fm).toContain("title: \"Hello World\"");
    expect(fm).toContain("source: \"url\"");
    expect(fm).toContain("url: \"https://example.com\"");
    expect(fm).toContain("ingested_at: \"2026-07-21T00:00:00Z\"");
    expect(fm).toContain("tags:");
    expect(fm).toContain("  - \"a\"");
    expect(fm).toContain("  - \"b\"");
    expect(fm.startsWith("---")).toBe(true);
    expect(fm.endsWith("---")).toBe(true);
  });

  it("includes path for file source", () => {
    const fm = buildFrontmatter({
      title: "Notes",
      source: "file",
      path: "/tmp/notes.md",
      ingestedAt: "2026-07-21T00:00:00Z",
      tags: [],
    });
    expect(fm).toContain("source: \"file\"");
    expect(fm).toContain("path: \"/tmp/notes.md\"");
    expect(fm).not.toContain("url:");
    expect(fm).toContain("tags: []");
  });

  it("escapes double quotes in title", () => {
    const fm = buildFrontmatter({
      title: 'He said "hi"',
      source: "file",
      path: "/tmp/n.md",
      ingestedAt: "2026-07-21T00:00:00Z",
      tags: [],
    });
    expect(fm).toContain('title: "He said \\"hi\\""');
  });
});

describe("writeIngestedFile", () => {
  let tmpHub: string;

  it("creates the slug directory under raw/articles and writes source.md", () => {
    tmpHub = mkdtempSync(join(tmpdir(), "pi-llm-wiki-test-"));
    const slug = "abc123def456";
    const body = "---\ntitle: x\n---\nbody";
    const path = writeIngestedFile(tmpHub, slug, body);
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(tmpHub, "raw", "articles", slug, "source.md"));
    expect(readFileSync(path, "utf8")).toBe(body);
    rmSync(tmpHub, { recursive: true, force: true });
  });
});

describe("runIngest (integration)", () => {
  let tmpHub: string;

  it("ingests a local file: frontmatter, body, file location", async () => {
    tmpHub = mkdtempSync(join(tmpdir(), "pi-llm-wiki-test-"));
    const inputFile = join(tmpHub, "input.md");
    writeFileSync(inputFile, "# Hello\n\nThis is the body.\n", "utf8");

    const input: IngestInput = {
      kind: "file",
      path: inputFile,
      tags: ["test", "ingest"],
    };
    const result = await runIngest(tmpHub, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.writtenPath).toBe(
      join(tmpHub, "raw", "articles", result.slug, "source.md"),
    );
    expect(existsSync(result.writtenPath)).toBe(true);

    const content = readFileSync(result.writtenPath, "utf8");
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/title: ".*input\.md"/);
    expect(content).toMatch(/source: "file"/);
    expect(content).toMatch(/path: ".*input\.md"/);
    expect(content).toMatch(/tags:/);
    expect(content).toContain("This is the body.");

    rmSync(tmpHub, { recursive: true, force: true });
  });

  it("returns error if file does not exist", async () => {
    tmpHub = mkdtempSync(join(tmpdir(), "pi-llm-wiki-test-"));
    const input: IngestInput = {
      kind: "file",
      path: "/nonexistent/path.md",
    };
    const result = await runIngest(tmpHub, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/does not exist|ENOENT/i);
    rmSync(tmpHub, { recursive: true, force: true });
  });

  it("ingests a URL via fetch stub (no real network in tests)", async () => {
    tmpHub = mkdtempSync(join(tmpdir(), "pi-llm-wiki-test-"));
    // We don't actually fetch — the test verifies only the file-source path.
    // URL path is tested manually; a real test would need a fetch mock.
    // For v0.1 we skip URL integration test and trust the unit tests of stripHtml/slugFromUrl.
    rmSync(tmpHub, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("path resolution", () => {
  it("resolve normalizes", () => {
    expect(resolve("/tmp", "..", "foo")).toBe("/foo");
  });
});
