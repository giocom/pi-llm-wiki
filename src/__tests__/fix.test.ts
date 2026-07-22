import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../lint.js";
import { runFix } from "../fix.js";

function writeWiki(hub: string, slug: string, body: string, withFrontmatter = true): void {
  const dir = join(hub, "wiki", slug);
  mkdirSync(dir, { recursive: true });
  const fm = withFrontmatter
    ? '---\ntitle: "Test"\nsource_slugs: ["x"]\ncompiled_at: "2026-07-22T00:00:00Z"\n---\n'
    : "";
  writeFileSync(join(dir, "index.md"), fm + body, "utf8");
}

describe("v0.14 — runFix", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-fix-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("does not touch raw/ files even with frontmatter issues", async () => {
    mkdirSync(join(tmp, "raw", "articles", "aa11"), { recursive: true });
    writeFileSync(join(tmp, "raw", "articles", "aa11", "source.md"), "no frontmatter here\n");
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fix = runFix(tmp, r.issues);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;
    // raw file should be unchanged
    const content = readFileSync(join(tmp, "raw", "articles", "aa11", "source.md"), "utf8");
    expect(content).toBe("no frontmatter here\n");
  });

  it("inserts missing wiki frontmatter fields", () => {
    writeWiki(tmp, "wiki1", "body content", false);
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fix = runFix(tmp, r.issues);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;
    const content = readFileSync(join(tmp, "wiki", "wiki1", "index.md"), "utf8");
    expect(content).toContain("title:");
    expect(content).toContain("source_slugs:");
    expect(content).toContain("compiled_at:");
  });

  it("replaces broken wikilinks with plain text", () => {
    writeWiki(
      tmp,
      "wiki1",
      "See [[nonexistent]] for context.",
      true,
    );
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fix = runFix(tmp, r.issues);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;
    const content = readFileSync(join(tmp, "wiki", "wiki1", "index.md"), "utf8");
    expect(content).not.toContain("[[nonexistent]]");
    expect(content).toContain("nonexistent");
  });

  it("preserves aliased wikilinks (uses the alias as plain text)", () => {
    writeWiki(tmp, "wiki1", "About [[missing|Display Name]] here.", true);
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    runFix(tmp, r.issues);
    const content = readFileSync(join(tmp, "wiki", "wiki1", "index.md"), "utf8");
    expect(content).toContain("Display Name");
    expect(content).not.toContain("[[missing|Display Name]]");
  });

  it("leaves valid wikilinks untouched", () => {
    // Create two slugs: wiki1, wiki2. wiki1 links to wiki2 — valid.
    writeWiki(tmp, "wiki1", "intro", true);
    writeWiki(tmp, "wiki2", "body that references [[wiki1]]", true);
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    runFix(tmp, r.issues);
    const content = readFileSync(join(tmp, "wiki", "wiki2", "index.md"), "utf8");
    expect(content).toContain("[[wiki1]]");
  });

  it("returns an empty results array when no issues are fixable", () => {
    writeWiki(tmp, "wiki1", "A normal body with several lines.\n\nMore content here.\n", true);
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fix = runFix(tmp, r.issues);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;
    expect(fix.results).toHaveLength(0);
  });
});
