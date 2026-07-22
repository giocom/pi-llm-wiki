import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdd, parseAddArgs } from "../add.js";
import type { LlmResult } from "../compile.js";

describe("runAdd", () => {
  let tmp: string;
  const stubLlm = async (): Promise<LlmResult> => ({
    text: "## Compiled\n\nA summary.",
    modelId: "stub/model",
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-add-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("chains ingest + compile (file)", async () => {
    const inputFile = join(tmp, "note.md");
    writeFileSync(inputFile, "# Title\n\nA short body.", "utf8");
    const r = await runAdd(
      { kind: "file", path: inputFile, tags: ["test"] },
      { hub: tmp },
      stubLlm,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ingest.writtenPath).toContain("raw/articles/");
    expect(r.compile).not.toBeNull();
    expect(r.compile!.compiled[0]!.wikiPath).toContain("wiki/");
    expect(r.compile!.compiled[0]!.wikiPath).toContain("index.md");
  });

  it("respects --no-compile (skips compile)", async () => {
    const inputFile = join(tmp, "note.md");
    writeFileSync(inputFile, "# T\n\nbody", "utf8");
    const r = await runAdd(
      { kind: "file", path: inputFile },
      { hub: tmp, noCompile: true },
      stubLlm,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ingest.ok).toBe(true);
    expect(r.compile).toBeNull();
  });

  it("skips compile when llm is null", async () => {
    const inputFile = join(tmp, "note.md");
    writeFileSync(inputFile, "# T\n\nbody", "utf8");
    const r = await runAdd(
      { kind: "file", path: inputFile },
      { hub: tmp },
      null,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compile).toBeNull();
  });

  it("propagates ingest error", async () => {
    const r = await runAdd(
      { kind: "file", path: "/nonexistent/note.md" },
      { hub: tmp },
      stubLlm,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.stage).toBe("ingest");
  });
});

describe("parseAddArgs", () => {
  it("parses a simple URL", () => {
    const r = parseAddArgs("https://example.com/article");
    expect("input" in r);
    if (!("input" in r)) return;
    expect(r.input.kind).toBe("url");
    if (r.input.kind === "url") expect(r.input.url).toBe("https://example.com/article");
    expect(r.noCompile).toBe(false);
  });

  it("parses a file path", () => {
    const r = parseAddArgs("/tmp/notes.md");
    expect("input" in r);
    if (!("input" in r)) return;
    expect(r.input.kind).toBe("file");
    if (r.input.kind === "file") expect(r.input.path).toBe("/tmp/notes.md");
  });

  it("recognizes --no-compile", () => {
    const r = parseAddArgs("https://example.com --no-compile");
    expect("input" in r);
    if (!("input" in r)) return;
    expect(r.noCompile).toBe(true);
  });

  it("parses --tags", () => {
    const r = parseAddArgs("https://example.com --tags=foo,bar");
    expect("input" in r);
    if (!("input" in r)) return;
    expect(r.input.tags).toEqual(["foo", "bar"]);
  });

  it("rejects empty args", () => {
    const r = parseAddArgs("");
    expect("error" in r);
  });

  it("rejects args without URL or path", () => {
    const r = parseAddArgs("--tags foo");
    expect("error" in r);
  });
});
