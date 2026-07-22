import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint, formatLintReport } from "../lint.js";

describe("runLint", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-lint-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty issues for a clean hub", () => {
    const slug = "clean01";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "Good"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags:\n  - "x"\n---\nClean body.',
    );
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.errors).toBe(0);
    expect(r.summary.warnings).toBe(0);
    expect(r.summary.filesScanned).toBe(1);
  });

  it("flags missing frontmatter as error", () => {
    const slug = "nofm00000";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(join(tmp, "raw", "articles", slug, "source.md"), "no frontmatter here");
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.errors).toBeGreaterThan(0);
    const fm = r.issues.find((i) => i.check === "frontmatter");
    expect(fm?.severity).toBe("error");
  });

  it("flags missing required field", () => {
    const slug = "miss000000";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "x"\n---\nbody',
    );
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const missing = r.issues.filter((i) => i.check === "frontmatter" && i.message.includes("source"));
    expect(missing.length).toBeGreaterThan(0);
  });

  it("flags broken wikilinks as warning", () => {
    const slug = "broken000000";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "x"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags: []\n---\nSee [[NoSuchSlug]] for details.',
    );
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wl = r.issues.find((i) => i.check === "wikilink");
    expect(wl?.severity).toBe("warning");
    expect(wl?.message).toContain("NoSuchSlug");
  });

  it("accepts a wikilink that resolves to an existing slug", () => {
    const slug1 = "aaa000000aaa";
    const slug2 = "bbb000000bbb";
    mkdirSync(join(tmp, "raw", "articles", slug1), { recursive: true });
    mkdirSync(join(tmp, "raw", "articles", slug2), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug1, "source.md"),
      '---\ntitle: "a"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags: []\n---\nbody',
    );
    writeFileSync(
      join(tmp, "raw", "articles", slug2, "source.md"),
      `-----\ntitle: "b"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags: []\n---\nSee [[${slug1}]] for context.`,
    );
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues.find((i) => i.check === "wikilink")).toBeUndefined();
  });

  it("flags empty bodies as warning", () => {
    const slug = "empty000000";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "x"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags: []\n---\n   \n  ',
    );
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.issues.find((i) => i.check === "empty");
    expect(e?.severity).toBe("warning");
  });

  it("flags duplicate content as warning", () => {
    const slug1 = "dup10000000a";
    const slug2 = "dup20000000b";
    mkdirSync(join(tmp, "raw", "articles", slug1), { recursive: true });
    mkdirSync(join(tmp, "raw", "articles", slug2), { recursive: true });
    const sameContent =
      '---\ntitle: "x"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags: []\n---\nsame body';
    writeFileSync(join(tmp, "raw", "articles", slug1, "source.md"), sameContent);
    writeFileSync(join(tmp, "raw", "articles", slug2, "source.md"), sameContent);
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dup = r.issues.filter((i) => i.check === "duplicate");
    expect(dup.length).toBe(2); // both files get a warning
  });

  it("flags non-normalized tags as info", () => {
    const slug = "tags00000000";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "x"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags:\n  - "Bitcoin"\n  - "Lightning "\n---\nbody',
    );
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const info = r.issues.filter((i) => i.check === "tags" && i.severity === "info");
    expect(info.length).toBeGreaterThan(0);
  });

  it("flags duplicate tags as warning", () => {
    const slug = "duptag000000";
    mkdirSync(join(tmp, "raw", "articles", slug), { recursive: true });
    writeFileSync(
      join(tmp, "raw", "articles", slug, "source.md"),
      '---\ntitle: "x"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags:\n  - "foo"\n  - "Foo"\n---\nbody',
    );
    const r = runLint(tmp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dup = r.issues.find((i) => i.check === "tags" && i.severity === "warning");
    expect(dup).toBeDefined();
  });

  it("returns error for non-existent hub", () => {
    const r = runLint("/no-such-hub-path-xyz");
    expect(r.ok).toBe(false);
  });
});

describe("formatLintReport", () => {
  it("renders grouped tables by severity", () => {
    const out = formatLintReport({
      ok: true,
      issues: [
        { severity: "error", check: "frontmatter", path: "raw/articles/x/source.md", message: "missing title" },
        { severity: "warning", check: "wikilink", path: "raw/articles/y/source.md", line: 5, message: "broken" },
        { severity: "info", check: "tags", path: "raw/articles/z/source.md", message: "not normalized" },
      ],
      summary: { errors: 1, warnings: 1, info: 1, filesScanned: 3 },
    });
    expect(out).toContain("ERROR");
    expect(out).toContain("WARNING");
    expect(out).toContain("INFO");
    expect(out).toContain("| check | path | line | message |");
    expect(out).toContain("`raw/articles/x/source.md`");
  });

  it("renders an empty message when there are no issues", () => {
    const out = formatLintReport({
      ok: true,
      issues: [],
      summary: { errors: 0, warnings: 0, info: 0, filesScanned: 5 },
    });
    expect(out).toContain("No issues found");
  });
});
