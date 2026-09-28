import type { Ask, Candidate, Doc, DrexClient, Problems, Verdict } from "../contracts.ts";
import { note } from "./problems.ts";
import { DrexFailure } from "../drex/client.ts";
import { dirAsk, fileAsk, surveyGuidance } from "../prompts/asks.ts";
import { termsIn } from "../probe/terms.ts";
import { inLanes } from "./lanes.ts";

const DIR_ADMIT = 0.5;
const FILE_ADMIT = 0.25;
const DIR_VISIT_CAP = 200;
const PICK_CAP = 80;
const LEX_PICK_CAP = 16;
const ASK_CAP = 64;
const BODY_CAP = 60_000;
const SKETCH_LINES = 30;
const SKETCH_FILES = 3;
const DESCENDANT_CAP = 48;
const FALLBACK_PICK_CAP = 24;
const WAVE_LANES = 16;


type FileLeaf = {
  form: "file";
  rel: string;
  label: string;
  doc: Doc;
};

type DirNode = {
  form: "dir";
  rel: string;
  label: string;
  kids: Map<string, DirNode | FileLeaf>;
};

type ScoreTarget =
  | { form: "dir"; node: DirNode }
  | { form: "file"; leaf: FileLeaf };

export type SurveyWording = {
  preview: (doc: Doc) => string;
  guidance: string;
  askFile: (query: string, path: string) => Ask;
  askDir: (query: string, path: string) => Ask;
};

type ViewCell = { names?: string[]; sketch: string; descendants?: string[] };

const FILLER: ReadonlySet<string> = new Set([
  ..."your our my you we i as than then also yes no not here there those these that this".split(" "),
  ..."any all every each sum combined total during before after under based according per if or and".split(" "),
  ..."tell find list show give confirm quick start starting between besides across within with".split(" "),
  ..."from to by of at in on please must might may shall will should would could can".split(" "),
  ..."had have has did do does been be were was are is how why where whose whom who which what for the an a".split(" "),
  ..."amount amounts payment payments vendor vendors credits debits period periods through llc inc ltd".split(" "),
]);

function placeDir(root: DirNode, rel: string): DirNode {
  if (rel === "") return root;
  let cur = root;
  let prefix = "";
  for (const part of rel.split("/")) {
    prefix = prefix ? `${prefix}/${part}` : part;
    let next = cur.kids.get(part);
    if (!next || next.form !== "dir") {
      next = { form: "dir", rel: prefix, label: part, kids: new Map() };
      cur.kids.set(part, next);
    }
    cur = next;
  }
  return cur;
}

function treeFromDocs(docs: Doc[]): DirNode {
  const root: DirNode = { form: "dir", rel: "", label: "", kids: new Map() };
  for (const doc of docs) {
    const cut = doc.rel.lastIndexOf("/");
    const folder = cut < 0 ? "" : doc.rel.slice(0, cut);
    const base = cut < 0 ? doc.rel : doc.rel.slice(cut + 1);
    const parent = placeDir(root, folder);
    parent.kids.set(base, { form: "file", rel: doc.rel, label: base, doc });
  }
  return root;
}

function squash(value: string): string {
  const lowered = value.normalize("NFKC").toLowerCase();
  return lowered.split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
}

type QueryLex = { all: string[]; strong: string[]; words?: SurveyWording };

function queryTokens(query: string): QueryLex {
  const all: string[] = [];
  const strong: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string, intoStrong: boolean) => {
    const key = squash(raw);
    if (key.length < 3 || seen.has(key)) return;
    seen.add(key);
    all.push(key);
    if (intoStrong) strong.push(key);
  };
  for (const term of termsIn(query)) {
    for (const part of squash(term.value).split(" ")) {
      if (part.length >= 3) add(part, true);
    }
  }
  for (const word of query.split(/\s+/)) {
    const key = squash(word);
    if (key.length < 4 || FILLER.has(key)) continue;
    if (/^(?:19|20)\d{2}$/.test(key)) continue;
    add(key, false);
  }
  return { all, strong };
}

function fieldHasToken(field: string, token: string): boolean {
  const padded = ` ${field} `;
  if (padded.includes(` ${token} `)) return true;
  if (token.length < 4) return false;
  for (const part of field.split(" ")) {
    if (part.startsWith(token)) return true;
  }
  return false;
}

function hitCount(path: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const field = squash(path);
  let n = 0;
  for (const token of tokens) {
    if (fieldHasToken(field, token)) n += 1;
  }
  return n;
}

function headLines(text: string, limit: number): string[] {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    kept.push(line);
    if (kept.length >= limit) break;
  }
  return kept;
}

function sketchFile(doc: Doc): string {
  return headLines(doc.body, SKETCH_LINES).join("\n");
}

const DEFAULT_WORDING: SurveyWording = {
  preview: sketchFile,
  guidance: surveyGuidance(),
  askFile: fileAsk,
  askDir: dirAsk,
};

function wordingOf(lex: QueryLex): SurveyWording {
  return lex.words ?? DEFAULT_WORDING;
}

function listFiles(node: DirNode): FileLeaf[] {
  const out: FileLeaf[] = [];
  const walk = (cur: DirNode) => {
    for (const name of [...cur.kids.keys()].sort()) {
      const child = cur.kids.get(name);
      if (!child) continue;
      if (child.form === "file") out.push(child);
      else walk(child);
    }
  };
  walk(node);
  return out;
}

function rankByQuery<T>(items: T[], pathOf: (item: T) => string, lex: QueryLex): T[] {
  if (lex.all.length === 0) return items;
  return [...items].sort((a, b) => {
    const sb = hitCount(pathOf(b), lex.strong);
    const sa = hitCount(pathOf(a), lex.strong);
    if (sb !== sa) return sb - sa;
    const hb = hitCount(pathOf(b), lex.all);
    const ha = hitCount(pathOf(a), lex.all);
    if (hb !== ha) return hb - ha;
    return pathOf(a).localeCompare(pathOf(b));
  });
}

function sketchDir(node: DirNode, lex: QueryLex): ViewCell {
  const names = [...node.kids.keys()].sort();
  const files = listFiles(node);
  const rankedFiles = rankByQuery(files, (f) => f.rel, lex);
  const parts: string[] = [];
  for (const leaf of rankedFiles.slice(0, SKETCH_FILES)) {
    const body = wordingOf(lex).preview(leaf.doc);
    if (body.length > 0) parts.push(`:: ${leaf.rel}\n${body}`);
  }
  const rankedPaths = rankByQuery(
    files.map((f) => f.rel),
    (p) => p,
    lex,
  );
  const descendants = rankedPaths.slice(0, DESCENDANT_CAP);
  return { names, sketch: parts.join("\n\n"), descendants };
}

function cellFor(target: ScoreTarget, lex: QueryLex): ViewCell {
  if (target.form === "dir") return sketchDir(target.node, lex);
  return { sketch: wordingOf(lex).preview(target.leaf.doc) };
}

function targetKey(target: ScoreTarget): string {
  return target.form === "dir" ? target.node.rel : target.leaf.rel;
}

function targetAsk(query: string, target: ScoreTarget, lex: QueryLex): Ask {
  const words = wordingOf(lex);
  if (target.form === "dir") return words.askDir(query, target.node.rel);
  return words.askFile(query, target.leaf.rel);
}

function bodySize(state: unknown, asks: Ask[]): number {
  return Buffer.byteLength(JSON.stringify({ state, questions: asks }), "utf8");
}

function composeState(
  parentRel: string,
  targets: ScoreTarget[],
  lex: QueryLex,
): { reminder: string; parent: string; views: Record<string, ViewCell> } {
  const views: Record<string, ViewCell> = {};
  for (const target of targets) {
    views[targetKey(target)] = cellFor(target, lex);
  }
  return {
    reminder: wordingOf(lex).guidance,
    parent: parentRel === "" ? "." : parentRel,
    views,
  };
}

function shrinkCell(cell: ViewCell): ViewCell {
  const nextSketch =
    cell.sketch.length > 0 ? cell.sketch.slice(0, Math.max(1, Math.floor(cell.sketch.length * 0.5))) : "";
  const nextDesc =
    cell.descendants && cell.descendants.length > 1
      ? cell.descendants.slice(0, Math.ceil(cell.descendants.length / 2))
      : cell.descendants && cell.descendants.length === 1
        ? []
        : cell.descendants;
  const nextNames =
    cell.names && cell.names.length > 8 ? cell.names.slice(0, Math.ceil(cell.names.length / 2)) : cell.names;
  return {
    ...(nextNames ? { names: nextNames } : {}),
    sketch: nextSketch,
    ...(nextDesc ? { descendants: nextDesc } : {}),
  };
}

function fitState(
  parentRel: string,
  targets: ScoreTarget[],
  asks: Ask[],
  lex: QueryLex,
): ReturnType<typeof composeState> {
  const state = composeState(parentRel, targets, lex);
  let size = bodySize(state, asks);
  let rounds = 0;
  while (size > BODY_CAP && rounds < 48) {
    rounds += 1;
    let changed = false;
    for (const key of Object.keys(state.views)) {
      const cell = state.views[key];
      if (!cell) continue;
      const next = shrinkCell(cell);
      if (
        next.sketch !== cell.sketch ||
        (next.descendants?.length ?? 0) !== (cell.descendants?.length ?? 0) ||
        (next.names?.length ?? 0) !== (cell.names?.length ?? 0)
      ) {
        state.views[key] = next;
        changed = true;
      }
    }
    if (!changed) break;
    size = bodySize(state, asks);
  }
  return state;
}

function splitBatches(
  query: string,
  parentRel: string,
  targets: ScoreTarget[],
  lex: QueryLex,
): ScoreTarget[][] {
  const batches: ScoreTarget[][] = [];
  let open: ScoreTarget[] = [];

  const pushOpen = () => {
    if (open.length > 0) batches.push(open);
    open = [];
  };

  for (const target of targets) {
    const trial = open.concat(target);
    const asks = trial.map((t) => targetAsk(query, t, lex));
    if (asks.length > ASK_CAP) {
      pushOpen();
      open = [target];
      continue;
    }
    const state = fitState(parentRel, trial, asks, lex);
    if (bodySize(state, asks) > BODY_CAP && open.length > 0) {
      pushOpen();
      open = [target];
      continue;
    }
    open = trial;
  }
  pushOpen();
  return batches;
}

async function askBatch(
  client: DrexClient,
  query: string,
  parentRel: string,
  targets: ScoreTarget[],
  halt: AbortSignal,
  problems: Problems,
  lex: QueryLex,
  forceShrink = false,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (targets.length === 0) return scores;

  const asks = targets.map((t) => targetAsk(query, t, lex));
  const state = fitState(parentRel, targets, asks, lex);
  if (forceShrink) {
    for (const key of Object.keys(state.views)) {
      const cell = state.views[key];
      if (cell) state.views[key] = shrinkCell(cell);
    }
  }

  try {
    if (halt.aborted) throw new DrexFailure("cancelled", "aborted");
    const verdicts: Verdict[] = await client.ask(state, asks, halt);
    for (const v of verdicts) scores.set(v.tag, v.probability);
    return scores;
  } catch (err) {
    if (!(err instanceof DrexFailure)) throw err;
    if (err.code === "cancelled") throw err;
    if (err.code === "token-limit") {
      if (targets.length > 1) {
        const mid = Math.floor(targets.length / 2);
        const left = await askBatch(
          client,
          query,
          parentRel,
          targets.slice(0, mid),
          halt,
          problems,
          lex,
          forceShrink,
        );
        const right = await askBatch(
          client,
          query,
          parentRel,
          targets.slice(mid),
          halt,
          problems,
          lex,
          forceShrink,
        );
        for (const [id, p] of left) scores.set(id, p);
        for (const [id, p] of right) scores.set(id, p);
        return scores;
      }
      if (!forceShrink) {
        return askBatch(client, query, parentRel, targets, halt, problems, lex, true);
      }
      note(problems, "token-limit", err.message);
      return scores;
    }
    note(problems, err.code, err.message);
    return scores;
  }
}

function bestDescendantHits(node: DirNode, tokens: string[]): number {
  let best = 0;
  for (const leaf of listFiles(node)) {
    const n = hitCount(leaf.rel, tokens);
    if (n > best) best = n;
  }
  return best;
}

function lexPathOk(path: string, lex: QueryLex): boolean {
  const strongHits = hitCount(path, lex.strong);
  if (strongHits >= 2) return true;
  if (strongHits >= 1 && hitCount(path, lex.all) >= 2) return true;
  if (lex.strong.length === 0 && hitCount(path, lex.all) >= 2) return true;
  return false;
}

function lexAdmitDir(node: DirNode, lex: QueryLex): boolean {
  for (const leaf of listFiles(node)) {
    if (lexPathOk(leaf.rel, lex)) return true;
  }
  // directory name itself (e.g. vendor folder) with a strong token
  if (node.rel && hitCount(node.rel, lex.strong) >= 1) return true;
  return bestDescendantHits(node, lex.all) >= 3 && lex.strong.length === 0;
}

function lexAdmitFile(path: string, lex: QueryLex): boolean {
  return lexPathOk(path, lex);
}

function fallbackCandidates(docs: Doc[], lex: QueryLex, admitted: Set<string>): Candidate[] {
  if (lex.all.length === 0) return [];
  const ranked = rankByQuery(
    docs.filter((d) => !admitted.has(d.rel)),
    (d) => d.rel,
    lex,
  );
  const out: Candidate[] = [];
  for (const doc of ranked) {
    if (!lexPathOk(doc.rel, lex)) {
      if (out.length > 0) break;
      continue;
    }
    const hits = hitCount(doc.rel, lex.all);
    out.push({
      rel: doc.rel,
      sha: doc.sha,
      weight: Math.min(0.45, 0.2 + 0.1 * hits),
      via: "survey",
    });
    if (out.length >= FALLBACK_PICK_CAP) break;
  }
  return out;
}

export async function survey(args: {
  client: DrexClient;
  docs: Doc[];
  question: string;
  cancel: AbortSignal;
  preview?: (doc: Doc) => string;
  guidanceText?: string;
  visitCap?: number;
  orderDirs?: (rels: string[]) => string[];
  askFile?: (query: string, path: string) => Ask;
  askDir?: (query: string, path: string) => Ask;
}): Promise<{ picks: Candidate[]; problems: Problems }> {
  const visitCap = args.visitCap ?? DIR_VISIT_CAP;
  const client = args.client;
  const docs = args.docs;
  const query = args.question;
  const halt = args.cancel;
  const problems: Problems = {};
  const picks: Candidate[] = [];
  const admitted = new Set<string>();
  const lex = queryTokens(query);
  lex.words = {
    preview: args.preview ?? DEFAULT_WORDING.preview,
    guidance: args.guidanceText ?? DEFAULT_WORDING.guidance,
    askFile: args.askFile ?? DEFAULT_WORDING.askFile,
    askDir: args.askDir ?? DEFAULT_WORDING.askDir,
  };
  const root = treeFromDocs(docs);
  const queue: DirNode[] = [root];
  const queued = new Set<string>([""]);
  let visits = 0;
  let lexPicks = 0;
  let stop = false;

  const hitLimit = (detail: string) => {
    note(problems, "resource_limit", detail);
    stop = true;
  };

  const enqueue = (node: DirNode) => {
    const key = node.rel;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(node);
  };

  const admit = (leaf: FileLeaf, weight: number) => {
    if (admitted.has(leaf.rel)) return;
    if (picks.length >= PICK_CAP) {
      hitLimit(`admitted files capped at ${PICK_CAP}`);
      return;
    }
    admitted.add(leaf.rel);
    picks.push({
      rel: leaf.rel,
      sha: leaf.doc.sha,
      weight,
      via: "survey",
    });
    if (picks.length >= PICK_CAP) {
      hitLimit(`admitted files capped at ${PICK_CAP}`);
    }
  };

  while (queue.length > 0 && !stop) {
    if (halt.aborted) throw new DrexFailure("cancelled", "aborted");
    if (visits >= visitCap) {
      hitLimit(`explored directories capped at ${visitCap}`);
      break;
    }
    if (picks.length >= PICK_CAP) {
      hitLimit(`admitted files capped at ${PICK_CAP}`);
      break;
    }

    // One breadth level is scored concurrently; admission then replays in queue order.
    if (args.orderDirs && queue.length > 1) {
      const byRel = new Map(queue.map((node) => [node.rel, node]));
      const order = args.orderDirs(queue.map((node) => node.rel));
      const sorted: DirNode[] = [];
      for (const rel of order) {
        const node = byRel.get(rel);
        if (node && byRel.delete(rel)) sorted.push(node);
      }
      queue.splice(0, queue.length, ...sorted, ...byRel.values());
    }
    const wave = queue.splice(0, visitCap - visits);
    visits += wave.length;
    const work: Array<{ node: DirNode; batch: ScoreTarget[] }> = [];
    for (const node of wave) {
      const targets: ScoreTarget[] = [];
      for (const name of [...node.kids.keys()].sort()) {
        const child = node.kids.get(name);
        if (!child) continue;
        if (child.form === "dir") targets.push({ form: "dir", node: child });
        else targets.push({ form: "file", leaf: child });
      }
      for (const batch of splitBatches(query, node.rel, targets, lex)) work.push({ node, batch });
    }
    const answered: Array<Map<string, number>> = new Array(work.length);
    await inLanes(work, WAVE_LANES, async ({ node, batch }, at) => {
      answered[at] = await askBatch(client, query, node.rel, batch, halt, problems, lex);
    });

    for (const [at, { batch }] of work.entries()) {
      if (stop) break;
      const scores = answered[at] ?? new Map<string, number>();

      for (const target of batch) {
        if (stop) break;
        const ask = targetAsk(query, target, lex);
        const p = scores.get(ask.tag);

        if (target.form === "dir") {
          const drexOk = p !== undefined && p >= DIR_ADMIT;
          if (drexOk || lexAdmitDir(target.node, lex)) {
            enqueue(target.node);
          }
          continue;
        }

        const drexOk = p !== undefined && p >= FILE_ADMIT;
        const lexOk = !drexOk && lexPicks < LEX_PICK_CAP && lexAdmitFile(target.leaf.rel, lex);
        if (drexOk || lexOk) {
          const score =
            p !== undefined ? p : Math.min(0.4, 0.2 + 0.08 * hitCount(target.leaf.rel, lex.all));
          const before = picks.length;
          admit(target.leaf, score);
          if (lexOk && picks.length > before) lexPicks += 1;
        }
      }
    }
  }

  if (picks.length === 0) {
    for (const pick of fallbackCandidates(docs, lex, admitted)) {
      admitted.add(pick.rel);
      picks.push(pick);
    }
  }

  return { picks, problems };
}
