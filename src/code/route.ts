import type { Ask, Candidate, Doc, DrexClient, Hit, Problems, Segment } from "../contracts.ts";
import { DrexFailure } from "../drex/client.ts";
import { judge } from "../pipeline/judge.ts";
import { note } from "../pipeline/problems.ts";
import { rankCode, type RankResult } from "../pipeline/rank.ts";
import { survey } from "../pipeline/survey.ts";
import { codeGuidance, codeSurveyGuidance, declAsk, linkAsk, nameAsk, triageAsk } from "../prompts/asks.ts";
import { segmenter } from "../segment/choose.ts";
import { defsOf, findDefs } from "./defs.ts";
import { grepNames } from "./grep.ts";
import { kindOf, kindWeight } from "./kind.ts";
import { linksFrom, siblingOverrides } from "./links.ts";
import { scoreFiles } from "./score.ts";
import type { CodeName, DefEntry, GrepHit, LinkTarget, Scored } from "./types.ts";

const NAME_KEEP = 0.4;
const TRIAGE_KEEP = 10;
const DECL_CAP = 12;
const SEG_BYTES = 12_000;
const LINE_BYTES = 200;
const BODY_CAP = 40_000;
const CHOSEN_BYTES = 6_000;
const CHOSEN_MIN = 0.5;
const HOPS = 2;
const HOP_FILES = 8;
const AMBIGUOUS_DEFS = 4;
const LINK_TRIAGE = 0.5;
const SURVEY_VISITS = 60;
const DEF_PREVIEW = 60;

const SOURCE_EXT = /\.(py|pyx|pyi|js|jsx|ts|tsx|mjs|cjs|c|h|cc|cpp|hpp|rs|go|java|rb)$/i;
const BACK_DIRS = /^(docs?|tests?|testing|examples?|\.github|benchmarks?|asv_bench|ci|tools?)(\/|$)/i;

export function sourceShare(docs: Doc[]): number {
  if (docs.length === 0) return 0;
  let n = 0;
  for (const doc of docs) if (SOURCE_EXT.test(doc.rel)) n++;
  return n / docs.length;
}

const PLAIN_SKIP: ReadonlySet<string> = new Set(
  "this that with from when have does work works working good bad should would could about there their which what shows".split(" "),
);
const PLAIN_CAP = 12;

export async function definedWords(question: string, dir: string, docs: Doc[], stop: AbortSignal): Promise<CodeName[]> {
  const words = [...new Set(question.toLowerCase().match(/\b[a-z][a-z0-9]{3,}\b/g) ?? [])]
    .filter((w) => !PLAIN_SKIP.has(w))
    .slice(0, 40);
  if (words.length === 0) return [];
  const defined = new Set((await findDefs(dir, docs, words, stop)).map((d) => d.name));
  return words
    .filter((w) => defined.has(w))
    .slice(0, PLAIN_CAP)
    .map((w) => ({ text: w, parts: [w], origin: "ident" as const }));
}

type Built = { state: unknown; asks: Ask[] };

function sizeOf(built: Built): number {
  return Buffer.byteLength(JSON.stringify({ state: built.state, questions: built.asks }), "utf8");
}

function packed<T>(items: T[], build: (some: T[]) => Built): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const entry of items) {
    const trial = cur.concat([entry]);
    if (cur.length > 0 && sizeOf(build(trial)) > BODY_CAP) {
      out.push(cur);
      cur = [entry];
    } else cur = trial;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

async function askSplit<T>(
  client: DrexClient,
  items: T[],
  build: (some: T[]) => Built,
  stop: AbortSignal,
  problems: Problems,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (items.length === 0) return out;
  const built = build(items);
  try {
    for (const v of await client.ask(built.state, built.asks, stop)) out.set(v.tag, v.probability);
  } catch (err) {
    if (!(err instanceof DrexFailure) || err.code === "cancelled" || err.code === "auth") throw err;
    if (err.code === "token-limit" && items.length > 1) {
      const mid = Math.floor(items.length / 2);
      const halves = await Promise.all(
        [items.slice(0, mid), items.slice(mid)].map((half) => askSplit(client, half, build, stop, problems)),
      );
      for (const half of halves) for (const [k, p] of half) out.set(k, p);
    } else note(problems, err.code, err.message);
  }
  return out;
}

async function askAll<T>(
  client: DrexClient,
  items: T[],
  build: (some: T[]) => Built,
  stop: AbortSignal,
  problems: Problems,
): Promise<Map<string, number>> {
  const parts = await Promise.all(packed(items, build).map((some) => askSplit(client, some, build, stop, problems)));
  const out = new Map<string, number>();
  for (const part of parts) for (const [k, p] of part) out.set(k, p);
  return out;
}

function clip(line: string): string {
  return line.length > LINE_BYTES ? `${line.slice(0, LINE_BYTES)}…` : line;
}

type NameStat = { name: CodeName; defined: number; mentioned: number };

function nameStats(names: CodeName[], hits: GrepHit[], defsByRel: Map<string, DefEntry[]>): NameStat[] {
  return names.map((name) => {
    const leaves = new Set(name.parts.map((p) => p.split(".").pop()!));
    let mentioned = 0;
    let defined = 0;
    for (const hit of hits) {
      if (!name.parts.some((p) => hit.names.has(p))) continue;
      mentioned++;
      if ((defsByRel.get(hit.rel) ?? []).some((d) => leaves.has(d.name))) defined++;
    }
    return { name, defined, mentioned };
  });
}

async function filterNames(
  client: DrexClient,
  question: string,
  stats: NameStat[],
  stop: AbortSignal,
  problems: Problems,
): Promise<CodeName[]> {
  const asked = stats.filter((s) => s.mentioned > 0);
  if (asked.length === 0) return [];
  const build = (some: NameStat[]): Built => ({
    state: {
      query: question,
      guidance: codeGuidance(),
      names: some.map((s) => ({ name: s.name.text, found_as: s.name.origin, defined_in_files: s.defined, mentioned_in_files: s.mentioned })),
    },
    asks: some.map((s) => nameAsk(question, s.name.text)),
  });
  const verdicts = await askAll(client, asked, build, stop, problems);
  if (verdicts.size === 0) return asked.map((s) => s.name);
  const kept = asked.filter((s) => (verdicts.get(nameAsk(question, s.name.text).tag) ?? 1) >= NAME_KEEP);
  return kept.map((s) => s.name);
}

function fileCard(scored: Scored, doc: Doc, defs: DefEntry[]): Record<string, unknown> {
  const lines = doc.body.split("\n");
  const wanted = new Set(scored.defines.map((d) => d.split(".").pop()!));
  const listed = [...defs].sort((x, y) => Number(wanted.has(y.name)) - Number(wanted.has(x.name)) || x.line - y.line);
  return {
    path: scored.rel,
    kind: scored.kind,
    definitions: listed.slice(0, 30).map((d) => (d.owner ? `${d.owner}.${d.name}` : d.name)),
    matches: scored.windows.map((w) => ({
      lines: `${w.from}-${w.to}`,
      text: lines.slice(w.from - 1, w.to).map(clip).join("\n"),
    })),
  };
}

async function triageFiles(
  client: DrexClient,
  question: string,
  scored: Scored[],
  docsByPath: Map<string, Doc>,
  defsByRel: Map<string, DefEntry[]>,
  stop: AbortSignal,
  problems: Problems,
): Promise<Map<string, number>> {
  const build = (some: Scored[]): Built => ({
    state: {
      query: question,
      guidance: codeGuidance(),
      files: some.map((s) => fileCard(s, docsByPath.get(s.rel)!, defsByRel.get(s.rel) ?? [])),
    },
    asks: some.map((s) => triageAsk(question, s.rel)),
  });
  const verdicts = await askAll(client, scored.filter((s) => docsByPath.has(s.rel)), build, stop, problems);
  const out = new Map<string, number>();
  for (const s of scored) {
    const p = verdicts.get(triageAsk(question, s.rel).tag);
    out.set(s.rel, p === undefined ? s.heuristic : 0.6 * p + 0.4 * s.heuristic);
  }
  return out;
}

function trimmed(seg: Segment): Segment {
  return seg.body.length > SEG_BYTES ? { ...seg, body: seg.body.slice(0, SEG_BYTES) } : seg;
}

function isClassHead(seg: Segment): boolean {
  return /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s/.test(seg.body);
}

function declPicker(lineHits: Map<string, number[]>, parts: Set<string>) {
  return (pick: Candidate, all: Segment[]): Segment[] => {
    const lines = lineHits.get(pick.rel) ?? [];
    const scored = all.map((seg, at) => {
      let score = 0;
      for (const line of lines) if (line >= seg.span.from && line <= seg.span.to) score++;
      if (parts.has(seg.title)) score += 5;
      return { seg, at, score };
    });
    const chosen = scored.filter((s) => s.score > 0).sort((x, y) => y.score - x.score || x.at - y.at).slice(0, DECL_CAP);
    const picked = new Set(chosen.map((c) => c.at));
    for (const c of [...chosen]) {
      if (picked.size >= DECL_CAP) break;
      for (let at = c.at - 1; at >= 0; at--) {
        const seg = all[at]!;
        if (!isClassHead(seg)) continue;
        if (seg.span.to + 1 >= c.seg.span.from || all.slice(at + 1, c.at).every((s) => !isClassHead(s))) picked.add(at);
        break;
      }
    }
    if (picked.size === 0) all.slice(0, 3).forEach((_, at) => picked.add(at));
    return [...picked].sort((x, y) => x - y).map((at) => trimmed(all[at]!));
  };
}

function segmentsAround(targets: Map<string, number[]>) {
  return (pick: Candidate, all: Segment[]): Segment[] => {
    const lines = targets.get(pick.rel) ?? [];
    const out = all.filter((seg) => lines.some((l) => l >= seg.span.from && l <= seg.span.to));
    return out.slice(0, DECL_CAP).map(trimmed);
  };
}

function chosenSegments(hits: Hit[]): Segment[] {
  const out: Segment[] = [];
  for (const hit of hits) {
    for (const quote of hit.quotes) {
      const sec = hit.sections.find((s) => s.span.from === quote.from && s.span.to === quote.to);
      if (!sec || sec.probability < CHOSEN_MIN) continue;
      out.push({
        key: `${hit.rel}#${quote.from}-${quote.to}`,
        rel: hit.rel,
        title: sec.title,
        span: { from: quote.from, to: quote.to },
        shape: "declaration",
        body: quote.body,
      });
    }
  }
  return out;
}

function chosenText(segs: Segment[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const seg of segs) {
    const room = CHOSEN_BYTES - used;
    if (room <= 200) break;
    const text = `# ${seg.rel}:${seg.span.from}-${seg.span.to}\n${seg.body}`.slice(0, room);
    parts.push(text);
    used += text.length + 1;
  }
  return parts.join("\n");
}

async function linkTargets(
  dir: string,
  docs: Doc[],
  chosen: Segment[],
  judged: Set<string>,
  stop: AbortSignal,
): Promise<Map<string, number[]>> {
  const called = linksFrom(chosen, new Map());
  const methods: Set<string> = new Set();
  for (const seg of chosen) methods.add(seg.title);
  const defs = await findDefs(dir, docs, [...new Set([...called, ...methods])], stop);

  const byName = new Map<string, Set<string>>();
  for (const d of defs) {
    const rels = byName.get(d.name) ?? new Set<string>();
    rels.add(d.rel);
    byName.set(d.name, rels);
  }
  const chosenRels = new Set(chosen.map((s) => s.rel));
  const ownDefs = docs.filter((d) => chosenRels.has(d.rel)).flatMap(defsOf);
  const targets: LinkTarget[] = siblingOverrides(chosen, ownDefs.concat(defs));
  const calledSet = new Set(called);
  for (const d of defs) {
    if (!calledSet.has(d.name) || d.form === "assign") continue;
    if ((byName.get(d.name)?.size ?? 0) > AMBIGUOUS_DEFS) continue;
    targets.push({ rel: d.rel, name: d.name, line: d.line, reason: "call" });
  }

  const docsByPath = new Map(docs.map((d) => [d.rel, d]));
  const weight = (t: LinkTarget) => {
    const doc = docsByPath.get(t.rel);
    const kind = doc ? kindWeight(kindOf(doc)) : 0;
    return kind * (t.reason === "sibling" ? 2 : 1);
  };
  const byRel = new Map<string, { lines: number[]; score: number }>();
  for (const t of targets) {
    if (judged.has(t.rel)) continue;
    const w = weight(t);
    if (w <= 0.1) continue;
    const row = byRel.get(t.rel) ?? { lines: [], score: 0 };
    row.lines.push(t.line);
    row.score += w;
    byRel.set(t.rel, row);
  }
  const ranked = [...byRel].sort((x, y) => y[1].score - x[1].score || (x[0] < y[0] ? -1 : 1)).slice(0, HOP_FILES);
  return new Map(ranked.map(([rel, row]) => [rel, row.lines]));
}

function codePreview(doc: Doc): string {
  return defsOf(doc)
    .slice(0, DEF_PREVIEW)
    .map((d) => `${d.line}: ${d.form} ${d.owner ? `${d.owner}.` : ""}${d.name}`)
    .join("\n");
}

function sourceFirst(rels: string[]): string[] {
  return [...rels].sort((x, y) => Number(BACK_DIRS.test(x)) - Number(BACK_DIRS.test(y)));
}

export type CodeResult = { ranked: RankResult; hits: Hit[]; problems: Problems[] };

function heuristicRanking(scored: Scored[], docsByPath: Map<string, Doc>, topK: number): RankResult {
  const hits: Hit[] = scored.map((s) => ({
    rel: s.rel,
    sha: docsByPath.get(s.rel)?.sha ?? "",
    rank: s.heuristic,
    via: "grep",
    sections: [],
    quotes: [],
  }));
  return {
    hits: hits.slice(0, topK),
    also: hits.slice(topK).map((h) => ({ rel: h.rel, rank: h.rank })),
  };
}

export async function codeRoute(args: {
  client: DrexClient;
  dir: string;
  docs: Doc[];
  docsByPath: Map<string, Doc>;
  question: string;
  names: CodeName[];
  cancel: AbortSignal;
  topK?: number;
}): Promise<CodeResult> {
  const { client, dir, docs, docsByPath, question, cancel } = args;
  const topK = args.topK ?? 6;
  const problems: Problems = {};
  const bags: Problems[] = [problems];
  const ablate = process.env.DREXGREP_ABLATE === "heuristic";

  const allParts = [...new Set(args.names.flatMap((n) => n.parts))];
  const hits = allParts.length > 0 ? await grepNames(dir, docs, allParts, cancel) : [];
  const defsByRel = new Map<string, DefEntry[]>();
  for (const hit of hits) {
    const doc = docsByPath.get(hit.rel);
    if (doc) defsByRel.set(hit.rel, defsOf(doc));
  }

  let kept = args.names;
  if (!ablate && hits.length > 0) {
    kept = await filterNames(client, question, nameStats(args.names, hits, defsByRel), cancel, problems);
  }
  const keptParts = new Set(kept.flatMap((n) => n.parts));
  const keptHits: GrepHit[] = [];
  for (const hit of hits) {
    const names = new Map([...hit.names].filter(([part]) => keptParts.has(part)));
    if (names.size > 0) keptHits.push({ rel: hit.rel, names });
  }

  let scored = scoreFiles({ hits: keptHits, names: kept, defsByRel, docsByPath, total: docs.length });
  if (ablate) return { ranked: heuristicRanking(scored, docsByPath, topK), hits: [], problems: bags };

  if (scored.length === 0) {
    const surveyed = await survey({
      client,
      docs,
      question,
      cancel,
      preview: codePreview,
      guidanceText: codeSurveyGuidance(),
      visitCap: SURVEY_VISITS,
      orderDirs: sourceFirst,
      askFile: triageAsk,
    });
    bags.push(surveyed.problems);
    scored = surveyed.picks
      .filter((p) => docsByPath.has(p.rel))
      .map((p) => {
        const doc = docsByPath.get(p.rel)!;
        if (!defsByRel.has(p.rel)) defsByRel.set(p.rel, defsOf(doc));
        const kind = kindOf(doc);
        return { rel: p.rel, heuristic: p.weight * kindWeight(kind), kind, defines: [], windows: [] };
      })
      .sort((x, y) => y.heuristic - x.heuristic)
      .slice(0, 25);
  }
  if (scored.length === 0) return { ranked: { hits: [], also: [] }, hits: [], problems: bags };

  const triage = await triageFiles(client, question, scored, docsByPath, defsByRel, cancel, problems);
  const top = [...scored]
    .sort((x, y) => (triage.get(y.rel) ?? 0) - (triage.get(x.rel) ?? 0) || (x.rel < y.rel ? -1 : 1))
    .slice(0, TRIAGE_KEEP);

  const lineHits = new Map<string, number[]>();
  for (const hit of keptHits) lineHits.set(hit.rel, [...hit.names.values()].flat());
  const picks: Candidate[] = top.map((s) => ({
    rel: s.rel,
    sha: docsByPath.get(s.rel)!.sha,
    weight: triage.get(s.rel) ?? 0,
    via: "grep",
  }));
  const judged = new Set(picks.map((p) => p.rel));
  const first = await judge({
    client,
    docsByPath,
    picks,
    question,
    cancel,
    followUp: false,
    pickSegments: declPicker(lineHits, keptParts),
    askFor: (q, entry, title, span) => declAsk(q, entry, title, span),
    guidanceText: codeGuidance(),
  });
  bags.push(first.problems);
  let found = first.hits;

  let frontier = first.hits;
  for (let hop = 0; hop < HOPS; hop++) {
    if (cancel.aborted) break;
    const chosen = chosenSegments(frontier);
    if (chosen.length === 0) break;
    const targets = await linkTargets(dir, docs, chosen, judged, cancel);
    if (targets.size === 0) break;
    const linkPicks: Candidate[] = [];
    for (const rel of targets.keys()) {
      const doc = docsByPath.get(rel);
      if (!doc) continue;
      judged.add(rel);
      triage.set(rel, LINK_TRIAGE);
      linkPicks.push({ rel, sha: doc.sha, weight: 0, via: "link" });
    }
    const next = await judge({
      client,
      docsByPath,
      picks: linkPicks,
      question,
      cancel,
      followUp: false,
      pickSegments: segmentsAround(targets),
      askFor: (q, entry, title, span) => linkAsk(q, entry, title, span),
      guidanceText: codeGuidance(),
      chosen: chosenText(chosen),
    });
    bags.push(next.problems);
    if (next.hits.length === 0) break;
    found = found.concat(next.hits);
    frontier = next.hits;
  }

  const kinds = new Map<string, number>();
  for (const hit of found) {
    const doc = docsByPath.get(hit.rel);
    if (doc) kinds.set(hit.rel, kindWeight(kindOf(doc)));
  }
  const ranked = rankCode({ hits: found, triage, kindWeight: kinds, topK });
  const listed = new Set([...ranked.hits, ...ranked.also].map((h) => h.rel));
  if (ranked.hits.length < topK) {
    for (const s of top) {
      if (ranked.hits.length >= topK) break;
      if (listed.has(s.rel)) continue;
      listed.add(s.rel);
      ranked.hits.push({ rel: s.rel, sha: docsByPath.get(s.rel)!.sha, rank: 0, via: "grep", sections: [], quotes: [] });
    }
  }
  for (const s of top) {
    if (listed.has(s.rel)) continue;
    listed.add(s.rel);
    ranked.also.push({ rel: s.rel, rank: 0 });
  }
  return { ranked, hits: found, problems: bags };
}
