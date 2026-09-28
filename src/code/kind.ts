import type { FileKind, KindApi, KindWeightApi } from "./types.ts";

const WEIGHTS: Record<FileKind, number> = {
  source: 1.0,
  test: 0.5,
  example: 0.4,
  docs: 0.3,
  changelog: 0.05,
  data: 0,
};

const CODE_EXT = /\.(py|pyx|pxd|pyi|js|jsx|ts|tsx|mjs|cjs|c|h|cc|cpp|hpp|rs|go|java|rb)$/i;

function digitShare(body: string): number {
  let digits = 0;
  let total = 0;
  const n = Math.min(body.length, 200_000);
  for (let i = 0; i < n; i++) {
    const c = body.charCodeAt(i);
    if (c <= 32) continue;
    total++;
    if (c >= 48 && c <= 57) digits++;
  }
  return total ? digits / total : 0;
}

export const kindOf: KindApi = (doc) => {
  const rel = doc.rel.toLowerCase();
  const segs = rel.split("/");
  const name = segs[segs.length - 1] ?? "";
  const dirs = segs.slice(0, -1);

  if (/^(changes|changelog|history|news|release[-_]?notes)/.test(name)) return "changelog";
  if (/^(issue_template|pull_request_template)/.test(name) || rel.includes(".github/issue_template")) return "changelog";
  if (dirs.some((d) => /^(announce|releases?|whatsnew|release[-_]?notes|changelog|changes|upcoming_changes)$/.test(d))) {
    return "changelog";
  }

  if (/\.(svg|ai|eps|pdf|png|jpe?g|gif|ico)$/.test(name)) return "data";
  if (/\.(json|csv|tsv|dat)$/.test(name) && doc.size > 20_000) return "data";
  if (doc.body.length > 2_000 && digitShare(doc.body) > 0.3) return "data";

  if (dirs.some((d) => d === "tests" || d === "test" || d === "testing")) return "test";
  if (/^test_.*\.py$|_test\.py$|^conftest\.py$|\.(test|spec)\.[jt]sx?$/.test(name)) return "test";

  if (dirs.some((d) => /^(examples?|galleries|gallery|benchmarks?|asv_bench|tutorials?)$/.test(d))) return "example";

  if (dirs.some((d) => d === "doc" || d === "docs")) return CODE_EXT.test(name) ? "example" : "docs";
  if (/\.(rst|md|txt)$/.test(name)) return "docs";

  return "source";
};

export const kindWeight: KindWeightApi = (kind) => WEIGHTS[kind];
