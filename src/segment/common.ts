import type { Doc, LineSpan, Segment } from "../contracts.ts";

export const BYTE_SOFT = 3000;
export const MERGE_SOFT = 2000;
export const JOIN_SOFT = 600;
export const ROW_CAP = 20;

export function linePieces(text: string): string[] {
  if (text.length === 0) return [""];
  return text.split(/\n/);
}

export function sliceLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join("\n");
}

export function byteSize(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function makeSeg(
  doc: Doc,
  title: string,
  span: LineSpan,
  kind: Segment["shape"],
  lines: string[],
): Segment {
  const text = sliceLines(lines, span.from, span.to);
  return {
    key: `${doc.rel}#${span.from}-${span.to}`,
    rel: doc.rel,
    title,
    span,
    shape: kind,
    body: text,
  };
}

export function pathSuffix(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

function extMatches(suffix: string, wanted: string): boolean {
  return suffix === wanted;
}

export function isScriptPath(p: string): boolean {
  const s = pathSuffix(p);
  if (extMatches(s, ".ts")) return true;
  if (extMatches(s, ".tsx")) return true;
  if (extMatches(s, ".js")) return true;
  if (extMatches(s, ".jsx")) return true;
  if (extMatches(s, ".mjs")) return true;
  if (extMatches(s, ".cjs")) return true;
  return false;
}

export function isPyPath(p: string): boolean {
  return extMatches(pathSuffix(p), ".py");
}
