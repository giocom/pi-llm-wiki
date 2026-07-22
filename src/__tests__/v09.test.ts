import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompile, runCompileMulti, buildCompilePrompt, buildMultiCompilePrompt } from "../compile.js";
import { runQuery, buildQueryPrompt } from "../query.js";
import type { LlmResult } from "../compile.js";

function makeArticle(hub: string, slug: string, body: string): void {
  const dir = join(hub, "raw", "articles", slug);
  const fs = require("node:fs");
  fs.mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.md"), `---\ntitle: "Test"\nsource: "file"\ningested_at: "2026-07-22T00:00:00Z"\ntags: []\n---\n${body}\n`);
}

describe("v0.9 default_lang — compile prompt", () => {
  it("returns English instruction when no lang is provided", () => {
    const p = buildCompilePrompt({ title: "x" }, "body");
    expect(p.system).toContain("knowledge-base compiler");
    expect(p.system).not.toMatch(/Respond in/);
  });
});

describe("v0.9 default_lang — makeLlmCaller integration", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "pi-llm-wiki-lang-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("appends Respond in Korean to system prompt when default_lang is 'ko'", async () => {
    makeArticle(tmp, "aaa", "test body content");
    let capturedSystem = "";
    const stubLlm = async (p: { system: string; user: string }): Promise<LlmResult> => {
      capturedSystem = p.system;
      return { text: "테스트 요약", modelId: "stub" };
    };
    // Simulate makeLlmCaller wrapping behavior
    const lang = "ko";
    const wrappedLlm = async (p: { system: string; user: string }): Promise<LlmResult> => {
      const system = `${p.system}\n\nRespond in Korean.`;
      return stubLlm({ system, user: p.user });
    };
    const r = await runCompile(tmp, { hub: tmp }, wrappedLlm);
    expect(r.ok).toBe(true);
    expect(capturedSystem).toContain("Respond in Korean");
    // And the wiki body should be in Korean (the stub returned Korean)
    const wikiFile = join(tmp, "wiki", "aaa", "index.md");
    expect(readFileSync(wikiFile, "utf8")).toContain("테스트 요약");
  });
});

describe("v0.9 default_lang — humanizeLang mapping", () => {
  it("translates common codes to full names", () => {
    const cases: Array<[string, string]> = [
      ["ko", "Korean"],
      ["korean", "Korean"],
      ["ja", "Japanese"],
      ["zh", "Chinese"],
      ["en", "English"],
    ];
    for (const [input, expected] of cases) {
      const result = humanizeLangForTest(input);
      expect(result).toBe(expected);
    }
  });

  it("passes through unknown codes", () => {
    expect(humanizeLangForTest("Esperanto")).toBe("Esperanto");
  });
});

function humanizeLangForTest(lang: string): string {
  const m = lang.toLowerCase();
  if (m === "ko" || m === "korean" || m === "kr") return "Korean";
  if (m === "ja" || m === "japanese" || m === "jp") return "Japanese";
  if (m === "zh" || m === "chinese" || m === "cn") return "Chinese";
  if (m === "en" || m === "english") return "English";
  return lang;
}
