import type { Candidate, Doc } from "../contracts.ts";

export const probeLimits = {
  files: 50,
  chainFiles: 10,
  perId: 10,
  hops: 2,
};

export type ProbeTerm = { form: "id" | "phrase" | "name"; value: string };

const FILLER: ReadonlySet<string> = new Set([
  ..."your our my you we i as than then also yes no not here there those these that this".split(" "),
  ..."any all every each sum combined total during before after under based according per if or and".split(" "),
  ..."tell find list show give confirm quick start starting between besides across within with".split(" "),
  ..."from to by of at in on please must might may shall will should would could can".split(" "),
  ..."had have has did do does been be were was are is how why where when whose whom who which what for the an a".split(" "),
]);

const CALENDAR: ReadonlySet<string> = new Set([
  ..."sun sat fri thurs thur thu wed tues tue mon".split(" "),
  ..."sunday saturday friday thursday wednesday tuesday monday".split(" "),
  ..."dec nov oct sept sep aug jul jun apr mar feb jan".split(" "),
  ..."december november october september august july june april march february january".split(" "),
  "may",
]);

const JOINERS: ReadonlySet<string> = new Set(["of", "and", "&"]);

function squash(value: string): string {
  let s = value.normalize("NFKC").toLowerCase();
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  return s.trim();
}

function wrapped(value: string): string {
  const body = squash(value);
  return body ? ` ${body} ` : " ";
}

function stripEdges(piece: string): string {
  let lo = 0;
  let hi = piece.length;
  while (lo < hi && !/[\p{L}\p{N}]/u.test(piece[lo]!)) lo++;
  while (hi > lo && !/[\p{L}\p{N}]/u.test(piece[hi - 1]!)) hi--;
  return piece.slice(lo, hi);
}

function countDigits(piece: string): number {
  return (piece.match(/\d/g) ?? []).length;
}

function yearAlone(piece: string): boolean {
  return piece.length === 4 && (piece.startsWith("19") || piece.startsWith("20")) && /^\d{4}$/.test(piece);
}

function yearMonthShape(piece: string): boolean {
  // 2024-07 or 2024/12
  const m = piece.match(/^(\d{4})([-/.])(\d{1,2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[3]);
  return y >= 1900 && y <= 2099 && mo >= 1 && mo <= 12;
}

function monthYearShape(piece: string): boolean {
  // 07-2024 or 9/2023
  const m = piece.match(/^(\d{1,2})([-/.])(\d{4})$/);
  if (!m) return false;
  const mo = Number(m[1]);
  const y = Number(m[3]);
  return y >= 1900 && y <= 2099 && mo >= 1 && mo <= 12;
}

function ymdShape(piece: string): boolean {
  // 2024-07-01 or 2024/7/1 optionally with time suffix
  const head = piece.replace(/T[\d:.]+Z?$/i, "");
  const m = head.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[3]);
  const d = Number(m[4]);
  return y >= 1900 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

function mdyShape(piece: string): boolean {
  // 9/25/2023 or 09-25-23
  const m = piece.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/);
  if (!m) return false;
  const mo = Number(m[1]);
  const d = Number(m[3]);
  let y = Number(m[4]);
  if ((m[4] as string).length === 2) y += 2000;
  return y >= 1900 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

function dayMonYearShape(piece: string): boolean {
  // 26-Jul-2025 or 26Jul2025
  const m = piece.match(/^(\d{1,2})[-/.]?([A-Za-z]{3,9})\.?[-/.]?(\d{2,4})$/);
  if (!m) return false;
  const day = Number(m[1]);
  const mon = m[2]!.toLowerCase().replace(/\.$/, "");
  if (!CALENDAR.has(mon)) return false;
  return day >= 1 && day <= 31;
}

function isCalendarNoise(piece: string): boolean {
  return (
    yearAlone(piece) ||
    yearMonthShape(piece) ||
    monthYearShape(piece) ||
    ymdShape(piece) ||
    mdyShape(piece) ||
    dayMonYearShape(piece)
  );
}

function qualifiesAsId(piece: string): boolean {
  return countDigits(piece) >= 3 && !isCalendarNoise(piece);
}

function chunks(text: string): string[] {
  const parts: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      parts.push(buf);
      buf = "";
    }
  };
  for (const ch of text) {
    if (/[\s|()[\]{}<>"'`“”‘’*;]/u.test(ch)) flush();
    else buf += ch;
  }
  flush();
  return parts;
}

function idsFrom(text: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of chunks(text)) {
    const token = stripEdges(part);
    if (!qualifiesAsId(token)) continue;
    const key = squash(token);
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    result.push(token);
  }
  return result;
}

function phrasesFrom(query: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i]!;
    if (ch === '"' || ch === "\u201c" || ch === "\u201d") {
      i++;
      let body = "";
      while (i < query.length) {
        const c = query[i]!;
        if (c === '"' || c === "\u201c" || c === "\u201d") break;
        body += c;
        i++;
      }
      const trimmed = body.trim();
      if (trimmed) result.push(trimmed);
      if (i < query.length) i++;
      continue;
    }
    i++;
  }
  return result;
}

function namesFrom(query: string): string[] {
  const found: string[] = [];
  const words = query.split(/\s+/).filter(Boolean);
  let run: string[] = [];

  const close = () => {
    while (run.length && JOINERS.has(run[run.length - 1]!.toLowerCase())) run.pop();
    if (run.length >= 2) found.push(run.join(" "));
    run = [];
  };

  words.forEach((raw, index) => {
    const word = stripEdges(raw);
    const lower = word.toLowerCase();
    const cal = lower.replace(/\.$/, "");

    if (/^[^\p{L}\p{N}&]/u.test(raw)) {
      close();
      return;
    }

    const proper =
      index > 0 &&
      /^\p{Lu}/u.test(word) &&
      !/\d/.test(word) &&
      !FILLER.has(lower) &&
      !CALENDAR.has(cal);

    if (proper) {
      run.push(word);
    } else if (run.length > 0 && JOINERS.has(raw.toLowerCase()) && (raw === "&" || raw === lower)) {
      run.push(raw);
    } else {
      close();
      return;
    }

    if (/[^\p{L}\p{N}]$/u.test(raw) && raw !== "&") close();
  });
  close();
  return found;
}

export function termsIn(query: string): ProbeTerm[] {
  const out: ProbeTerm[] = [];
  const seen = new Set<string>();
  const add = (kind: ProbeTerm["form"], text: string) => {
    const key = squash(text);
    if (key.length < 3 || seen.has(key)) return;
    seen.add(key);
    out.push({ form: kind, value: text });
  };
  for (const p of phrasesFrom(query)) add("phrase", p);
  for (const id of idsFrom(query)) add("id", id);
  for (const n of namesFrom(query)) add("name", n);
  return out;
}

export function matchDocs(
  docs: Doc[],
  terms: Array<{ form: "id" | "phrase" | "name"; value: string }>,
  limit: number,
): Candidate[] {
  type Row = { doc: Doc; field: string };
  const rows: Row[] = docs.map((doc) => ({
    doc,
    field: wrapped(doc.rel + " " + doc.body),
  }));

  const active: string[] = [];
  const owners = new Map<string, number[]>();

  for (const term of terms) {
    const key = squash(term.value);
    if (!key || owners.has(key)) continue;
    const needle = ` ${key} `;
    const idxs: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.field.includes(needle)) idxs.push(i);
    }
    if (idxs.length === 0 || idxs.length > 50) continue;
    owners.set(key, idxs);
    active.push(key);
  }

  if (active.length === 0) return [];

  const bag: Array<{ doc: Doc; weight: number; share: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    let hit = 0;
    for (const key of active) {
      if (owners.get(key)!.includes(i)) hit++;
    }
    if (hit === 0) continue;
    const share = hit / active.length;
    bag.push({ doc: rows[i]!.doc, share, weight: 0.6 + 0.4 * share });
  }

  bag.sort((left, right) => {
    if (right.weight !== left.weight) return right.weight - left.weight;
    return left.doc.rel.localeCompare(right.doc.rel);
  });

  return bag.slice(0, limit).map((item) => ({
    rel: item.doc.rel,
    sha: item.doc.sha,
    weight: item.weight,
    via: "probe" as const,
    matchedShare: item.share,
  }));
}

export function freshIds(text: string, known: Set<string>): string[] {
  const blocked = new Set([...known].map(squash));
  return idsFrom(text).filter((id) => !blocked.has(squash(id)));
}

function chainIdRank(id: string): number {
  const letters = (id.match(/[A-Za-z]/g) ?? []).length;
  const digits = (id.match(/\d/g) ?? []).length;
  // Prefer document-like tokens (letters + digits) over bare zips/phones/qty.
  return (letters > 0 ? 200 : 0) + digits * 3 + Math.min(id.length, 24);
}

export function chainCandidates(docs: Doc[], ids: string[], already: Set<string>): Candidate[] {
  const pool = docs.filter((d) => !already.has(d.rel));
  const rows = pool.map((doc) => ({ doc, field: wrapped(doc.rel + " " + doc.body) }));
  const chosen = new Map<string, { doc: Doc; n: number }>();
  let filled = 0;
  const ordered = [...ids].sort((a, b) => chainIdRank(b) - chainIdRank(a) || a.localeCompare(b));

  for (const id of ordered) {
    if (filled >= probeLimits.chainFiles) break;
    const key = squash(id);
    if (!key) continue;
    const needle = ` ${key} `;
    let forThis = 0;
    for (const row of rows) {
      if (filled >= probeLimits.chainFiles || forThis >= probeLimits.perId) break;
      if (!row.field.includes(needle)) continue;
      const prior = chosen.get(row.doc.rel);
      if (prior) {
        prior.n += 1;
        continue;
      }
      chosen.set(row.doc.rel, { doc: row.doc, n: 1 });
      forThis += 1;
      filled += 1;
    }
  }

  const denom = Math.max(
    1,
    ids.reduce((acc, id) => acc + (squash(id) ? 1 : 0), 0),
  );

  const picked: Candidate[] = [];
  for (const { doc, n } of chosen.values()) {
    const share = n / denom;
    picked.push({
      rel: doc.rel,
      sha: doc.sha,
      weight: 0.4 + 0.15 * share,
      via: "chain",
      matchedShare: share,
    });
  }

  picked.sort((a, b) => b.weight - a.weight || a.rel.localeCompare(b.rel));
  return picked.slice(0, probeLimits.chainFiles);
}
