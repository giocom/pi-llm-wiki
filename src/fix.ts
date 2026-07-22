/**
 * pi-llm-wiki v0.14 — /wiki:lint --fix
 *
 * Applies safe mechanical fixes to wiki/ files based on lint findings.
 * Raw files are NEVER modified (the "raw is immutable" principle).
 *
 * Fixable issues:
 *   - frontmatter: missing required fields (title, source/ingested_at for raw,
 *     source_slugs + compiled_at for wiki) — inserted with sensible defaults
 *   - wikilinks: broken `[[X]]` targets are replaced with their plain-text
 *     form (so `[[wikilink]]` becomes `wikilink`). This preserves the
 *     semantic content while removing the broken link.
 *
 * Non-fixable (reported as unfixable so the LLM can act):
 *   - empty body (no safe automatic fix)
 *   - duplicate content (ambiguous which to keep)
 *   - non-normalized tags (needs LLM judgement on canonical form)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { LintIssue } from "./lint.js";
import { parseFrontmatter } from "./list.js";

export interface FixResult {
  /** Absolute path to the file that was modified. */
  path: string;
  /** Issues that were fixed. */
  fixed: LintIssue[];
  /** Issues that could not be fixed automatically. */
  unfixable: LintIssue[];
}

export type FixAllResult =
  | { ok: true; results: FixResult[] }
  | { ok: false; error: string };

const RAW_RAW = "raw";
const WIKI_DIR = "wiki";

function isRawPath(rel: string): boolean {
  return rel.startsWith(RAW_RAW + "/");
}

function isWikiPath(rel: string): boolean {
  return rel.startsWith(WIKI_DIR + "/");
}

function requiredRawFields(): string[] {
  return ["title", "source", "ingested_at"];
}

function requiredWikiFields(): string[] {
  return ["title", "source_slugs", "compiled_at"];
}

function nowIso(): string {
  return new Date().toISOString();
}

function unquoteYaml(s: string): string {
  return s.replace(/^"|"$/g, "");
}

/**
 * Fix the frontmatter of a single file. Inserts any missing required
 * fields with safe defaults. Returns the updated content and the list
 * of fields that were added. If no fix is needed, returns null.
 */
function fixFrontmatter(content: string, isRaw: boolean): {
  newContent: string;
  addedFields: string[];
} | null {
  const required = isRaw ? requiredRawFields() : requiredWikiFields();
  const { meta, body } = parseFrontmatter(content);
  const missing = required.filter((k) => {
    const v = meta[k];
    if (v === undefined || v === null) return true;
    if (typeof v === "string" && v.length === 0) return true;
    return false;
  });
  if (missing.length === 0) return null;

  // Build a list of insertion lines. Reuse existing values where present.
  const lines: string[] = [];
  for (const k of missing) {
    let val: string;
    if (k === "title") val = "untitled";
    else if (k === "source") val = "unknown";
    else if (k === "ingested_at") val = nowIso();
    else if (k === "compiled_at") val = nowIso();
    else if (k === "source_slugs") val = "[]";
    else val = "unknown";
    lines.push(`${k}: ${val === "[]" ? "[]" : `"${val}"`}`);
  }

  if (!content.startsWith("---")) {
    // No frontmatter at all — create one.
    const newContent = `---\n${lines.join("\n")}\n---\n\n${body}\n`;
    return { newContent, addedFields: missing };
  }

  // Existing frontmatter: insert missing keys before the closing `---`.
  const end = content.indexOf("\n---", 3);
  if (end < 0) return null;
  const beforeClose = content.slice(0, end + 1);
  const afterClose = content.slice(end + 1);
  const newContent = `${beforeClose}\n${lines.join("\n")}${afterClose}`;
  return { newContent, addedFields: missing };
}

/**
 * Replace a broken `[[X]]` wikilink with the plain text `X`. The
 * surrounding line is returned with the change applied.
 */
function fixWikilinkInLine(line: string): string {
  return line.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = target.trim();
    return alias ? alias.trim() : t;
  });
}

function fixWikilinks(content: string, fileRel: string, issues: LintIssue[]): {
  newContent: string;
  fixed: number;
} | null {
  const wkIssues = issues.filter((i) => i.check === "wikilink" && i.path === fileRel);
  if (wkIssues.length === 0) return null;
  const lines = content.split("\n");
  let changed = false;
  for (const issue of wkIssues) {
    if (issue.line === undefined) continue;
    const idx = issue.line - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const newLine = fixWikilinkInLine(lines[idx]!);
    if (newLine !== lines[idx]) {
      lines[idx] = newLine;
      changed = true;
    }
  }
  if (!changed) return null;
  return { newContent: lines.join("\n"), fixed: wkIssues.length };
}

function isFixable(issue: LintIssue): boolean {
  if (issue.check === "frontmatter" || issue.check === "wikilink") return true;
  return false;
}

/**
 * Apply safe mechanical fixes to a hub. Only modifies wiki/ files; raw
 * files are never touched. Returns a per-file breakdown.
 */
export function runFix(hub: string, lintIssues: LintIssue[]): FixAllResult {
  if (lintIssues.length === 0) return { ok: true, results: [] };
  const byFile = new Map<string, LintIssue[]>();
  for (const i of lintIssues) {
    const arr = byFile.get(i.path) ?? [];
    arr.push(i);
    byFile.set(i.path, arr);
  }

  const results: FixResult[] = [];
  for (const [rel, issues] of byFile) {
    if (!isWikiPath(rel)) continue;
    const filePath = join(hub, rel);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      return { ok: false, error: `read error: ${(err as Error).message}` };
    }
    let newContent = content;
    const fixed: LintIssue[] = [];
    const unfixable: LintIssue[] = [];

    const fm = fixFrontmatter(newContent, false);
    if (fm) {
      newContent = fm.newContent;
      for (const k of fm.addedFields) {
        fixed.push({
          severity: "info",
          check: "frontmatter",
          path: rel,
          message: `Inserted missing field: ${k}`,
        });
      }
    }

    const wk = fixWikilinks(newContent, rel, issues);
    if (wk) {
      newContent = wk.newContent;
      fixed.push({
        severity: "info",
        check: "wikilink",
        path: rel,
        message: `Replaced ${wk.fixed} broken wikilink(s) with plain text`,
      });
    }

    for (const i of issues) {
      if (!isFixable(i) && !fixed.some((f) => f.check === i.check && f.path === i.path)) {
        unfixable.push(i);
      } else if (i.check !== "frontmatter" && i.check !== "wikilink" && !fixed.includes(i)) {
        // already added by fm or wk fix above
      }
    }

    if (newContent !== content) {
      try {
        writeFileSync(filePath, newContent, "utf8");
      } catch (err) {
        return { ok: false, error: `write error: ${(err as Error).message}` };
      }
    }

    results.push({ path: filePath, fixed, unfixable });
  }
  return { ok: true, results };
}
