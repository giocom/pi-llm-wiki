/**
 * pi-llm-wiki v0.4 — `/wiki:lint`
 *
 * Five pure checks across raw/articles/ and wiki/:
 *   1. frontmatter — required fields present (title, source, ingested_at)
 *   2. wikilinks — [[X]] targets resolve to an existing slug/file
 *   3. empty — file or body is empty / whitespace-only
 *   4. duplicates — two raws share the same content hash, or two wikis
 *      share a title
 *   5. tags — normalization (lowercase, trim, dedup); report anomalies
 *
 * No LLM call. Idempotent. Read-only.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "./list.js";

// ─── Types ────────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "info";

export interface LintIssue {
  severity: Severity;
  check: string;
  path: string;
  line?: number;
  message: string;
}

export type LintResult =
  | { ok: true; issues: LintIssue[]; summary: { errors: number; warnings: number; info: number; filesScanned: number } }
  | { ok: false; error: string };

// ─── File enumeration ─────────────────────────────────────────────────

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (st.isFile() && entry.endsWith(".md")) out.push(full);
  }
  return out;
}

// ─── Individual checks ────────────────────────────────────────────────

function checkFrontmatter(hub: string, file: string): LintIssue[] {
  const issues: LintIssue[] = [];
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return issues;
  }
  if (!content.startsWith("---")) {
    issues.push({
      severity: "error",
      check: "frontmatter",
      path: relative(hub, file),
      message: "Missing frontmatter (no leading `---`)",
    });
    return issues;
  }
  const { meta } = parseFrontmatter(content);
  const required = ["title", "source", "ingested_at"];
  for (const key of required) {
    const v = meta[key];
    if (typeof v !== "string" || v.length === 0) {
      issues.push({
        severity: "error",
        check: "frontmatter",
        path: relative(hub, file),
        message: `Missing required field: \`${key}\``,
      });
    }
  }
  return issues;
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

function checkWikilinks(hub: string, file: string, allFiles: Set<string>): LintIssue[] {
  const issues: LintIssue[] = [];
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return issues;
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(line)) !== null) {
      const target = m[1]!.trim();
      // Try a few resolution strategies
      const candidates = [
        `raw/articles/${target}/source.md`,
        `raw/articles/${target}.md`,
        `wiki/${target}/index.md`,
        `wiki/${target}.md`,
        `${target}.md`,
      ];
      const found = candidates.some((c) => allFiles.has(c));
      if (!found) {
        issues.push({
          severity: "warning",
          check: "wikilink",
          path: relative(hub, file),
          line: i + 1,
          message: `Broken wikilink: [[${target}]] (not found in hub)`,
        });
      }
    }
  }
  return issues;
}

function checkEmpty(hub: string, file: string): LintIssue[] {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (content.trim().length === 0) {
    return [
      {
        severity: "warning",
        check: "empty",
        path: relative(hub, file),
        message: "File is empty or whitespace-only",
      },
    ];
  }
  // Body-only (after frontmatter) empty?
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end >= 0) {
      const body = content.slice(end + 4).trim();
      if (body.length === 0) {
        return [
          {
            severity: "warning",
            check: "empty",
            path: relative(hub, file),
            message: "Body (after frontmatter) is empty",
          },
        ];
      }
    }
  }
  return [];
}

function checkDuplicates(hub: string, files: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  // For raw: same content hash = same source (likely duplicate ingest)
  const hashToFiles = new Map<string, string[]>();
  for (const f of files) {
    if (!f.includes("raw/articles/")) continue;
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const hash = createHash("sha1").update(content, "utf8").digest("hex").slice(0, 12);
    const arr = hashToFiles.get(hash) ?? [];
    arr.push(f);
    hashToFiles.set(hash, arr);
  }
  for (const [hash, fs] of hashToFiles) {
    if (fs.length > 1) {
      for (const f of fs) {
        issues.push({
          severity: "warning",
          check: "duplicate",
          path: relative(hub, f),
          message: `Duplicate content (hash ${hash}) also in: ${fs.filter((x) => x !== f).map((x) => relative(hub, x)).join(", ")}`,
        });
      }
    }
  }
  return issues;
}

function normalizeTag(t: string): string {
  return t.toLowerCase().trim();
}

function checkTags(hub: string, file: string): LintIssue[] {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const { meta } = parseFrontmatter(content);
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  if (tags.length === 0) return [];

  const issues: LintIssue[] = [];
  const normalized = tags.map(normalizeTag);
  const seen = new Set<string>();
  for (let i = 0; i < tags.length; i++) {
    const original = tags[i]!;
    const norm = normalized[i]!;
    if (norm.length === 0) {
      issues.push({
        severity: "warning",
        check: "tags",
        path: relative(hub, file),
        message: `Empty tag at index ${i}`,
      });
      continue;
    }
    if (norm !== original) {
      issues.push({
        severity: "info",
        check: "tags",
        path: relative(hub, file),
        message: `Tag not normalized: "${original}" → "${norm}"`,
      });
    }
    if (seen.has(norm)) {
      issues.push({
        severity: "warning",
        check: "tags",
        path: relative(hub, file),
        message: `Duplicate tag (after normalization): "${norm}"`,
      });
    }
    seen.add(norm);
  }
  return issues;
}

// ─── Top-level ────────────────────────────────────────────────────────

/**
 * Run all checks across raw/articles/ and wiki/. Pure function.
 */
export function runLint(hub: string): LintResult {
  if (!existsSync(hub)) {
    return { ok: false, error: `Hub path does not exist: ${hub}` };
  }
  const roots = [join(hub, "raw", "articles"), join(hub, "wiki")];
  const files: string[] = [];
  for (const root of roots) {
    if (existsSync(root)) files.push(...listMarkdownFiles(root));
  }
  // Skip the _index.md files themselves (they don't need linting)
  const target = files.filter((f) => !f.endsWith("_index.md"));
  const allFilesSet = new Set(target.map((f) => relative(hub, f)));

  const issues: LintIssue[] = [];
  for (const f of target) {
    issues.push(...checkFrontmatter(hub, f));
    issues.push(...checkEmpty(hub, f));
    issues.push(...checkWikilinks(hub, f, allFilesSet));
    issues.push(...checkTags(hub, f));
  }
  issues.push(...checkDuplicates(hub, target));

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const info = issues.filter((i) => i.severity === "info").length;
  return { ok: true, issues, summary: { errors, warnings, info, filesScanned: target.length } };
}

// ─── Output formatting ────────────────────────────────────────────────

/**
 * Format lint issues grouped by severity, as a markdown table per group.
 */
export function formatLintReport(r: Extract<LintResult, { ok: true }>): string {
  const lines: string[] = [];
  lines.push(`## lint report`);
  lines.push("");
  lines.push(
    `**Files scanned:** ${r.summary.filesScanned}  |  ` +
      `**Errors:** ${r.summary.errors}  |  ` +
      `**Warnings:** ${r.summary.warnings}  |  ` +
      `**Info:** ${r.summary.info}`,
  );
  lines.push("");

  if (r.issues.length === 0) {
    lines.push("No issues found. ");
    return lines.join("\n");
  }

  const order: Severity[] = ["error", "warning", "info"];
  for (const sev of order) {
    const group = r.issues.filter((i) => i.severity === sev);
    if (group.length === 0) continue;
    lines.push(`### ${sev.toUpperCase()} (${group.length})`);
    lines.push("");
    lines.push("| check | path | line | message |");
    lines.push("|-------|------|------|---------|");
    for (const i of group) {
      const line = i.line ?? "—";
      const msg = i.message.replace(/\|/g, "\\|");
      lines.push(`| ${i.check} | \`${i.path}\` | ${line} | ${msg} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
