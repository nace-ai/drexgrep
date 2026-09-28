import type { Doc, Segment } from "../contracts.ts";
import { makeSeg } from "./common.ts";

const DECL = /^(\s*)(class|def)\s+([A-Za-z_][\w]*)/;

function indentWidth(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 8;
    else break;
  }
  return n;
}

function isNoise(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith("#");
}

function declAt(line: string): { indent: number; form: "class" | "def"; label: string } | null {
  const m = DECL.exec(line);
  if (!m) return null;
  if (line.trimStart() !== line.slice(indentWidth(line))) {
    // ok
  }
  const indent = m[1]!.length; // spaces only style; tabs rare
  // prefer visual indent
  const vis = indentWidth(line);
  return { indent: vis, form: m[2] as "class" | "def", label: m[3]! };
}

function blockEnd(lines: string[], startIdx: number, baseIndent: number): number {
  // startIdx 0-based; return 0-based last line of block
  let last = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isNoise(line)) {
      last = i;
      continue;
    }
    if (indentWidth(line) <= baseIndent) break;
    last = i;
  }
  // trim trailing noise
  while (last > startIdx && isNoise(lines[last] ?? "")) last--;
  return last;
}

export function segmentPy(doc: Doc, lines: string[]): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isNoise(line)) {
      i++;
      continue;
    }
    const d = declAt(line);
    if (!d || d.indent !== 0) {
      i++;
      continue;
    }

    if (d.form === "def") {
      const end = blockEnd(lines, i, 0);
      out.push(
        makeSeg(
          doc,
          d.label,
          { from: i + 1, to: end + 1 },
          "declaration",
          lines,
        ),
      );
      i = end + 1;
      continue;
    }

    // class at module level: emit class preamble + direct methods
    const classEnd = blockEnd(lines, i, 0);
    let bodyIndent: number | null = null;
    for (let j = i + 1; j <= classEnd; j++) {
      const L = lines[j] ?? "";
      if (isNoise(L)) continue;
      bodyIndent = indentWidth(L);
      break;
    }

    let cursor = i + 1;
    let preambleEnd = i;

    const flushPreamble = () => {
      if (preambleEnd >= i) {
        out.push(
          makeSeg(
            doc,
            d.label,
            { from: i + 1, to: preambleEnd + 1 },
            "declaration",
            lines,
          ),
        );
      }
    };

    let emittedMethod = false;
    while (cursor <= classEnd) {
      const L = lines[cursor] ?? "";
      if (isNoise(L)) {
        if (!emittedMethod) preambleEnd = cursor;
        cursor++;
        continue;
      }
      const inner = declAt(L);
      if (
        inner &&
        inner.form === "def" &&
        bodyIndent !== null &&
        inner.indent === bodyIndent
      ) {
        if (!emittedMethod) {
          flushPreamble();
          emittedMethod = true;
        }
        const mEnd = blockEnd(lines, cursor, inner.indent);
        out.push(
          makeSeg(
            doc,
            inner.label,
            { from: cursor + 1, to: mEnd + 1 },
            "declaration",
            lines,
          ),
        );
        cursor = mEnd + 1;
        continue;
      }
      if (!emittedMethod) preambleEnd = cursor;
      cursor++;
    }

    if (!emittedMethod) {
      out.push(
        makeSeg(
          doc,
          d.label,
          { from: i + 1, to: classEnd + 1 },
          "declaration",
          lines,
        ),
      );
    }

    i = classEnd + 1;
  }
  return out;
}
