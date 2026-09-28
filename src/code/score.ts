import type { Doc, LineSpan } from "../contracts.ts";
import { kindOf, kindWeight } from "./kind.ts";
import type { CodeName, DefEntry, GrepHit, Scored } from "./types.ts";

const KEEP = 25;
const WINDOWS = 3;
const REACH = 2;
const DEFINES_BOOST = 3;
const MODULE_BOOST = 2;
const STEM_BOOST = 1.5;
const PLAIN_SHARE = 0.5;

export function rarity(hits: GrepHit[], total: number): Map<string, number> {
  const df = new Map<string, number>();
  for (const hit of hits) for (const part of hit.names.keys()) df.set(part, (df.get(part) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const [part, n] of df) out.set(part, Math.log((total + 1) / (n + 1)) + 0.1);
  return out;
}

function definesPart(defs: DefEntry[], part: string): boolean {
  const bits = part.split(".");
  const leaf = bits[bits.length - 1]!;
  const owner = bits.length > 1 ? bits[bits.length - 2] : undefined;
  return defs.some((d) => d.name === leaf && (!owner || d.owner === owner || d.form === "class"));
}

function modulePaths(names: CodeName[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!name.text.includes(".") || name.text.includes("/")) continue;
    const bits = name.text.split(".");
    for (let n = bits.length; n >= 2; n--) out.push(bits.slice(0, n).join("/").toLowerCase());
  }
  return out;
}

function tracedFile(rel: string, names: CodeName[]): boolean {
  const tail = rel.split("/").slice(-2).join("/");
  return names.some((n) => n.file !== undefined && n.file.replace(/\\/g, "/").endsWith(tail));
}

function windowsOf(hit: GrepHit, idf: Map<string, number>): LineSpan[] {
  const parts = [...hit.names.keys()].sort((x, y) => (idf.get(y) ?? 0) - (idf.get(x) ?? 0));
  const spans: LineSpan[] = [];
  for (const part of parts) {
    for (const line of hit.names.get(part) ?? []) {
      if (spans.length >= WINDOWS) break;
      if (spans.some((s) => line >= s.from && line <= s.to)) continue;
      spans.push({ from: Math.max(1, line - REACH), to: line + REACH });
    }
    if (spans.length >= WINDOWS) break;
  }
  return spans.sort((x, y) => x.from - y.from);
}

export function scoreFiles(args: {
  hits: GrepHit[];
  names: CodeName[];
  defsByRel: Map<string, DefEntry[]>;
  docsByPath: Map<string, Doc>;
  total: number;
  keep?: number;
}): Scored[] {
  const idf = rarity(args.hits, args.total);
  const modules = modulePaths(args.names);
  const coded = new Set(args.names.filter((n) => n.origin !== "plain").flatMap((n) => n.parts));
  const plainOnly = new Set(
    args.names.filter((n) => n.origin === "plain").flatMap((n) => n.parts).filter((p) => !coded.has(p)),
  );
  const stems: Set<string> = new Set();
  for (const name of args.names) for (const part of name.parts) stems.add(part.split(".").pop()!.toLowerCase());

  type Row = Scored & { raw: number; traced: boolean };
  const rows: Row[] = [];
  for (const hit of args.hits) {
    const doc = args.docsByPath.get(hit.rel);
    if (!doc) continue;
    const kind = kindOf(doc);
    const weight = kindWeight(kind);
    const defs = args.defsByRel.get(hit.rel) ?? [];
    const defines: string[] = [];
    let raw = 0;
    for (const part of hit.names.keys()) {
      let gain = (idf.get(part) ?? 0) * (plainOnly.has(part) ? PLAIN_SHARE : 1);
      if (definesPart(defs, part)) {
        gain *= DEFINES_BOOST;
        defines.push(part);
      }
      raw += gain;
    }
    const lower = hit.rel.toLowerCase();
    if (modules.some((m) => lower.includes(`${m}/`) || lower.endsWith(`${m}.py`))) raw *= MODULE_BOOST;
    const stem = lower.split("/").pop()!.replace(/\.\w+$/, "");
    if (stems.has(stem)) raw *= STEM_BOOST;
    rows.push({
      rel: hit.rel,
      heuristic: raw * weight,
      kind,
      defines,
      windows: windowsOf(hit, idf),
      raw,
      traced: weight > 0 && tracedFile(hit.rel, args.names),
    });
  }

  let top = 0;
  for (const row of rows) if (row.heuristic > top) top = row.heuristic;
  for (const row of rows) {
    if (row.traced) row.heuristic = top * 1.01;
  }
  top = 0;
  for (const row of rows) if (row.heuristic > top) top = row.heuristic;

  rows.sort((x, y) => y.heuristic - x.heuristic || (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
  return rows.slice(0, args.keep ?? KEEP).map((row) => ({
    rel: row.rel,
    heuristic: top > 0 ? row.heuristic / top : 0,
    kind: row.kind,
    defines: row.defines,
    windows: row.windows,
  }));
}
