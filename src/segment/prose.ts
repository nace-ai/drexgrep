import type { Doc, Segment } from "../contracts.ts";
import {
  BYTE_SOFT,
  JOIN_SOFT,
  MERGE_SOFT,
  ROW_CAP,
  byteSize,
  makeSeg,
} from "./common.ts";

type Mark = { depth: number; label: string; at: number };

type Block =
  | { form: "words"; from: number; to: number }
  | { form: "grid"; from: number; to: number; headEnd: number };

function fenceOpen(line: string): string | null {
  const m = /^(```+|~~~+)/.exec(line.trimEnd());
  return m ? m[1]![0]! : null;
}

function listLike(line: string): boolean {
  return /^\s{0,3}([-*+]|\d+\.)\s+/.test(line);
}

function readAtx(line: string): { depth: number; label: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!m) return null;
  return {
    depth: m[1]!.length,
    label: (m[2] ?? "").replace(/\s+#+\s*$/, "").trim(),
  };
}

function setextLevel(line: string): 1 | 2 | null {
  if (/^=+\s*$/.test(line)) return 1;
  if (/^-{2,}\s*$/.test(line)) return 2;
  return null;
}

function collectMarks(lines: string[]): Mark[] {
  const marks: Mark[] = [];
  let fence: string | null = null;
  let inYaml = lines.length > 0 && /^---\s*$/.test(lines[0]!);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";

    if (inYaml) {
      if (i > 0 && (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw))) inYaml = false;
      continue;
    }

    const tick = fenceOpen(raw);
    if (tick) {
      if (fence === null) fence = tick;
      else if (tick === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const atx = readAtx(raw);
    if (atx) {
      marks.push({ depth: atx.depth, label: atx.label, at: i + 1 });
      continue;
    }

    const lvl = setextLevel(raw);
    if (lvl && i > 0) {
      const prev = lines[i - 1] ?? "";
      if (prev.trim() !== "" && !listLike(prev) && !readAtx(prev)) {
        marks.push({ depth: lvl, label: prev.trim(), at: i });
      }
    }
  }
  return marks;
}

function pathJoin(parts: string[]): string {
  return parts.filter(Boolean).join(" > ");
}

type Section = {
  title: string;
  parentKey: string;
  from: number;
  to: number;
  headingOnly: boolean;
};

function buildSections(lines: string[], marks: Mark[]): Section[] {
  const sections: Section[] = [];
  const stack: { depth: number; label: string }[] = [];

  const firstAt = marks[0]!.at;
  if (firstAt > 1) {
    const lead = lines.slice(0, firstAt - 1).join("\n").trim();
    if (lead.length > 0) {
      sections.push({
        title: "",
        parentKey: "",
        from: 1,
        to: firstAt - 1,
        headingOnly: false,
      });
    }
  }

  for (let m = 0; m < marks.length; m++) {
    const mark = marks[m]!;
    while (stack.length && stack[stack.length - 1]!.depth >= mark.depth) stack.pop();
    stack.push({ depth: mark.depth, label: mark.label });
    const labels = stack.map((s) => s.label);
    const from = mark.at;
    const to = m + 1 < marks.length ? marks[m + 1]!.at - 1 : lines.length;
    const body = lines.slice(from, to).join("\n").trim();
    sections.push({
      title: pathJoin(labels),
      parentKey: pathJoin(labels.slice(0, -1)),
      from,
      to: Math.max(from, to),
      headingOnly: body.length === 0,
    });
  }
  return sections;
}

function pipeRow(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && /^\|?.+\|.+\|?$/.test(t);
}

function sepRow(line: string): boolean {
  const t = line.trim();
  return /^\|?\s*:?-{1,}\s*(\|\s*:?-{1,}\s*)+\|?\s*$/.test(t);
}

function findBlocks(lines: string[], from: number, to: number): Block[] {
  const blocks: Block[] = [];
  let i = from;
  while (i <= to) {
    if (pipeRow(lines[i - 1] ?? "")) {
      const gridStart = i;
      let j = i + 1;
      while (j <= to && pipeRow(lines[j - 1] ?? "")) j++;
      const headEnd =
        gridStart + 1 < j && sepRow(lines[gridStart + 1 - 1]!)
          ? gridStart + 1
          : gridStart;
      blocks.push({ form: "grid", from: gridStart, to: j - 1, headEnd });
      i = j;
    } else {
      const proseStart = i;
      let j = i + 1;
      while (j <= to && !pipeRow(lines[j - 1] ?? "")) j++;
      blocks.push({ form: "words", from: proseStart, to: j - 1 });
      i = j;
    }
  }
  return blocks;
}

function packByParagraph(
  doc: Doc,
  title: string,
  lines: string[],
  from: number,
  to: number,
  kind: Segment["shape"],
): Segment[] {
  const out: Segment[] = [];
  if (from > to) return out;

  const paras: { from: number; to: number }[] = [];
  let pStart = from;
  for (let i = from; i <= to; i++) {
    if ((lines[i - 1] ?? "").trim() === "") {
      if (pStart < i) paras.push({ from: pStart, to: i - 1 });
      pStart = i + 1;
    }
  }
  if (pStart <= to) paras.push({ from: pStart, to });

  let a = -1;
  let b = -1;
  let weight = 0;
  const flush = () => {
    if (a < 0) return;
    out.push(makeSeg(doc, title, { from: a, to: b }, kind, lines));
    a = -1;
    b = -1;
    weight = 0;
  };

  for (const para of paras) {
    const n = byteSize(lines.slice(para.from - 1, para.to).join("\n"));
    if (a < 0) {
      a = para.from;
      b = para.to;
      weight = n;
      continue;
    }
    if (weight + n + 1 <= BYTE_SOFT) {
      b = para.to;
      weight += n + 1;
    } else {
      flush();
      a = para.from;
      b = para.to;
      weight = n;
    }
  }
  flush();
  return out;
}

function emitRowGroups(
  doc: Doc,
  title: string,
  lines: string[],
  grid: Extract<Block, { form: "grid" }>,
  attachBefore: { from: number; to: number } | null,
  attachAfter: { from: number; to: number } | null,
): Segment[] {
  const headText = lines.slice(grid.from - 1, grid.headEnd).join("\n");
  const dataIdx: number[] = [];
  for (let r = grid.headEnd + 1; r <= grid.to; r++) dataIdx.push(r);

  type Group = { rows: number[] };
  const groups: Group[] = [];
  if (dataIdx.length === 0) {
    groups.push({ rows: [] });
  } else {
    let cur: number[] = [];
    let weight = byteSize(headText);
    for (const r of dataIdx) {
      const add = byteSize(lines[r - 1] ?? "") + 1;
      if (cur.length > 0 && (cur.length >= ROW_CAP || weight + add > BYTE_SOFT)) {
        groups.push({ rows: cur });
        cur = [];
        weight = byteSize(headText);
      }
      cur.push(r);
      weight += add;
    }
    if (cur.length) groups.push({ rows: cur });
  }

  const out: Segment[] = [];
  for (let g = 0; g < groups.length; g++) {
    const rows = groups[g]!.rows;
    const firstRow = rows.length ? rows[0]! : grid.from;
    const lastRow = rows.length ? rows[rows.length - 1]! : grid.headEnd;

    let spanFrom = rows.length ? firstRow : grid.from;
    let spanTo = lastRow;

    if (g === 0) {
      spanFrom = attachBefore ? attachBefore.from : grid.from;
    }
    if (g === groups.length - 1 && attachAfter) {
      spanTo = attachAfter.to;
    }

    // Contiguous span in the file. First group begins at header (or lead prose).
    // Later groups only span their data rows; header is copied into text.
    if (g === 0) {
      const seg = makeSeg(
        doc,
        title,
        { from: spanFrom, to: spanTo },
        "table",
        lines,
      );
      out.push(seg);
    } else {
      const rowText = lines.slice(firstRow - 1, lastRow).join("\n");
      const afterText =
        g === groups.length - 1 && attachAfter
          ? "\n" + lines.slice(attachAfter.from - 1, attachAfter.to).join("\n")
          : "";
      const seg = makeSeg(
        doc,
        title,
        { from: firstRow, to: spanTo },
        "table",
        lines,
      );
      seg.body = headText + "\n" + rowText + afterText;
      out.push(seg);
    }
  }
  return out;
}

function splitLarge(
  doc: Doc,
  title: string,
  lines: string[],
  from: number,
  to: number,
): Segment[] {
  const blocks = findBlocks(lines, from, to);
  const out: Segment[] = [];
  let bi = 0;
  while (bi < blocks.length) {
    const b = blocks[bi]!;
    if (b.form === "words") {
      const next = blocks[bi + 1];
      if (next?.form === "grid") {
        const prose = lines.slice(b.from - 1, b.to).join("\n");
        if (byteSize(prose) <= JOIN_SOFT) {
          let after: { from: number; to: number } | null = null;
          const maybe = blocks[bi + 2];
          if (maybe?.form === "words") {
            const tail = lines.slice(maybe.from - 1, maybe.to).join("\n");
            if (byteSize(tail) <= JOIN_SOFT) after = { from: maybe.from, to: maybe.to };
          }
          out.push(
            ...emitRowGroups(
              doc,
              title,
              lines,
              next,
              { from: b.from, to: b.to },
              after,
            ),
          );
          bi += after ? 3 : 2;
          continue;
        }
      }
      out.push(...packByParagraph(doc, title, lines, b.from, b.to, "prose"));
      bi++;
      continue;
    }

    let after: { from: number; to: number } | null = null;
    const maybe = blocks[bi + 1];
    if (maybe?.form === "words") {
      const tail = lines.slice(maybe.from - 1, maybe.to).join("\n");
      if (byteSize(tail) <= JOIN_SOFT) after = { from: maybe.from, to: maybe.to };
    }
    out.push(...emitRowGroups(doc, title, lines, b, null, after));
    bi += after ? 2 : 1;
  }
  return out;
}

function foldEmpty(sections: Section[]): Section[] {
  const out: Section[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (!s.headingOnly) {
      out.push(s);
      continue;
    }
    const next = sections.slice(i + 1).find((x) => !x.headingOnly);
    if (next) next.from = Math.min(next.from, s.from);
    else if (out.length) out[out.length - 1]!.to = Math.max(out[out.length - 1]!.to, s.to);
    else out.push({ ...s, headingOnly: false });
  }
  return out;
}

function materialize(doc: Doc, sec: Section, lines: string[]): Segment[] {
  const text = lines.slice(sec.from - 1, sec.to).join("\n");
  if (byteSize(text) <= BYTE_SOFT) {
    return [
      makeSeg(doc, sec.title, { from: sec.from, to: sec.to }, "heading", lines),
    ];
  }
  return splitLarge(doc, sec.title, lines, sec.from, sec.to);
}

function parentOf(title: string): string {
  const idx = title.lastIndexOf(" > ");
  return idx < 0 ? "" : title.slice(0, idx);
}

function leafOf(title: string): string {
  const idx = title.lastIndexOf(" > ");
  return idx < 0 ? title : title.slice(idx + 3);
}

function mergedTitle(parent: string, leaves: string[]): string {
  const named = leaves.filter((leaf) => leaf.length > 0).join("; ");
  if (parent.length === 0) return named;
  return named.length > 0 ? `${parent} > ${named}` : parent;
}

function mergeAdjacent(doc: Doc, segs: Segment[], lines: string[]): Segment[] {
  if (segs.length <= 1) return segs;
  const out: Segment[] = [];
  let i = 0;
  while (i < segs.length) {
    let cur = segs[i]!;
    const leaves = [leafOf(cur.title)];
    while (i + 1 < segs.length) {
      const nxt = segs[i + 1]!;
      if (cur.shape !== "heading" || nxt.shape !== "heading") break;
      if (parentOf(cur.title) !== parentOf(nxt.title)) break;
      if (cur.span.to + 1 !== nxt.span.from) break;
      const combo = lines.slice(cur.span.from - 1, nxt.span.to).join("\n");
      if (byteSize(combo) > MERGE_SOFT) break;
      leaves.push(leafOf(nxt.title));
      cur = makeSeg(
        doc,
        mergedTitle(parentOf(cur.title), leaves),
        { from: cur.span.from, to: nxt.span.to },
        "heading",
        lines,
      );
      i++;
    }
    out.push(cur);
    i++;
  }
  return out;
}

function fallbackChunks(doc: Doc, lines: string[]): Segment[] {
  if (doc.body.length === 0) return [];
  return packByParagraph(doc, "", lines, 1, lines.length, "fallback");
}

export function segmentProse(doc: Doc, lines: string[]): Segment[] {
  const marks = collectMarks(lines);
  if (marks.length === 0) return fallbackChunks(doc, lines);
  const sections = foldEmpty(buildSections(lines, marks));
  const raw: Segment[] = [];
  for (const sec of sections) raw.push(...materialize(doc, sec, lines));
  return mergeAdjacent(doc, raw, lines);
}
