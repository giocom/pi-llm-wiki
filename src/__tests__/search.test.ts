import { describe, it, expect } from "vitest";
import { parseSearchArgs, normalizeSearchTag, buildSearchPrompt, buildSearchHint, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from "../search.js";

describe("parseSearchArgs", () => {
  it("parses a simple query", () => {
    const r = parseSearchArgs("llm-wiki");
    expect("request" in r).toBe(true);
    if (!("request" in r)) return;
    expect(r.request.query).toBe("llm-wiki");
    expect(r.request.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it("parses --limit=N", () => {
    const r = parseSearchArgs("bitcoin --limit=5");
    if (!("request" in r)) throw new Error("expected request");
    expect(r.request.query).toBe("bitcoin");
    expect(r.request.limit).toBe(5);
  });

  it("parses --limit N (space-separated)", () => {
    const r = parseSearchArgs("lightning network --limit 7");
    if (!("request" in r)) throw new Error("expected request");
    expect(r.request.query).toBe("lightning network");
    expect(r.request.limit).toBe(7);
  });

  it("clamps to MAX_LIMIT", () => {
    const r = parseSearchArgs("foo --limit=999");
    if (!("request" in r)) throw new Error("expected request");
    expect(r.request.limit).toBe(SEARCH_MAX_LIMIT);
  });

  it("rejects empty query", () => {
    const r = parseSearchArgs("");
    expect("error" in r).toBe(true);
  });

  it("rejects invalid limit", () => {
    const r = parseSearchArgs("foo --limit=abc");
    expect("error" in r).toBe(true);
  });

  it("rejects negative limit", () => {
    const r = parseSearchArgs("foo --limit=-1");
    expect("error" in r).toBe(true);
  });
});

describe("normalizeSearchTag", () => {
  it("lowercases and replaces whitespace", () => {
    expect(normalizeSearchTag("LLM Wiki")).toBe("llm-wiki");
  });

  it("strips non-alphanumeric characters", () => {
    expect(normalizeSearchTag("hello, world!")).toBe("hello-world");
  });

  it("collapses consecutive hyphens", () => {
    expect(normalizeSearchTag("a  b  c")).toBe("a-b-c");
  });

  it("trims leading/trailing hyphens", () => {
    expect(normalizeSearchTag("---foo---")).toBe("foo");
  });

  it("truncates long queries", () => {
    expect(normalizeSearchTag("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });

  it("handles Korean by stripping non-ASCII", () => {
    expect(normalizeSearchTag("한글 태그")).toBe("");
  });
});

describe("buildSearchPrompt", () => {
  it("mentions query, limit, and tag", () => {
    const out = buildSearchPrompt("llm-wiki", 3, "llm-wiki");
    expect(out).toContain("llm-wiki");
    expect(out).toContain("3 most relevant");
    expect(out).toContain("wiki_ingest");
    expect(out).toContain("llm-wiki");
  });

  it("uses singular when limit=1", () => {
    const out = buildSearchPrompt("foo", 1, "foo");
    expect(out).toContain("1 most relevant URL");
    expect(out).toContain("ingest");
  });
});

describe("buildSearchHint", () => {
  it("returns both prompt and tag", () => {
    const h = buildSearchHint({ query: "BitCoin", limit: 5 });
    expect(h.tag).toBe("bitcoin");
    expect(h.prompt).toContain("BitCoin");
    expect(h.prompt).toContain("bitcoin"); // tag in tool call
  });
});
