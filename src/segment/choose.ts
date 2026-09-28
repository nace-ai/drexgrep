import type { Doc, Segment, Segmenter } from "../contracts.ts";
import { isPyPath, isScriptPath, linePieces } from "./common.ts";
import { segmentProse } from "./prose.ts";
import { segmentPy } from "./pyindent.ts";
import { segmentScript } from "./script.ts";

export function segmentDocument(doc: Doc): Segment[] {
  const lines = linePieces(doc.body);

  if (isScriptPath(doc.rel)) {
    const coded = segmentScript(doc, lines);
    if (coded) return coded;
    return segmentProse(doc, lines);
  }

  if (isPyPath(doc.rel)) {
    const py = segmentPy(doc, lines);
    if (py.length > 0) return py;
    return segmentProse(doc, lines);
  }

  return segmentProse(doc, lines);
}

export function outlineOf(doc: Doc): string {
  const segs = segmentDocument(doc);
  const titles: string[] = [];
  let chars = 0;
  for (const s of segs) {
    if (titles.length >= 80) break;
    const line = s.title || "(untitled)";
    if (chars + line.length + 1 > 4000) break;
    titles.push(line);
    chars += line.length + 1;
  }
  return titles.join("\n");
}

export function segmenter(): Segmenter {
  return {
    segments: (doc) => segmentDocument(doc),
    outline: (doc) => outlineOf(doc),
  };
}
