import { describe, it, expect } from "vitest";
import { hasWikiTrigger } from "../agents.js";

describe("v0.12 — hasWikiTrigger", () => {
  it("returns true for /wiki: commands", () => {
    expect(hasWikiTrigger("/wiki:ls")).toBe(true);
    expect(hasWikiTrigger("/wiki:ingest https://example.com")).toBe(true);
    expect(hasWikiTrigger("/wiki:query bitcoin")).toBe(true);
  });

  it("returns true for explicit 'wiki' references", () => {
    expect(hasWikiTrigger("wiki로 정리해줘")).toBe(true);
    expect(hasWikiTrigger("위키에 추가해")).toBe(true);
    expect(hasWikiTrigger("Show me the wiki index")).toBe(true);
  });

  it("returns true for '워키' (alt spelling)", () => {
    expect(hasWikiTrigger("워키로 정리")).toBe(true);
  });

  it("returns true for 한국어 작업 동사 (정리, 만들어 등)", () => {
    expect(hasWikiTrigger("회의록 정리해줘")).toBe(true);
    expect(hasWikiTrigger("비트코인 자료 좀 만들어줘")).toBe(true);
    expect(hasWikiTrigger("이거 요약해줘")).toBe(true);
  });

  it("returns true for English work verbs", () => {
    expect(hasWikiTrigger("Please compile this article")).toBe(true);
    expect(hasWikiTrigger("Run a query for me")).toBe(true);
    expect(hasWikiTrigger("Can you merge these two?")).toBe(true);
    expect(hasWikiTrigger("Lint the hub")).toBe(true);
  });

  it("returns true for ingest mentions", () => {
    expect(hasWikiTrigger("ingest that URL")).toBe(true);
  });

  it("returns false for unrelated prompts", () => {
    expect(hasWikiTrigger("Hello, how are you?")).toBe(false);
    expect(hasWikiTrigger("What's the weather today?")).toBe(false);
    expect(hasWikiTrigger("Review this code: function foo() {}")).toBe(false);
    expect(hasWikiTrigger("Write me a poem")).toBe(false);
  });

  it("returns false for empty / non-string input", () => {
    expect(hasWikiTrigger("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(hasWikiTrigger("/wiki:ls")).toBe(true);
    expect(hasWikiTrigger("/WIKI:ls")).toBe(true);
    expect(hasWikiTrigger("Wiki Query")).toBe(true);
    expect(hasWikiTrigger("COMPILE this")).toBe(true);
  });

  it("returns false for non-wiki 'index' contexts (no English 'index' trigger)", () => {
    expect(hasWikiTrigger("index this array")).toBe(false);
    expect(hasWikiTrigger("array index out of bounds")).toBe(false);
  });
});
