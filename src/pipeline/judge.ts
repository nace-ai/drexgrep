import type {
  Ask,
  Candidate,
  Doc,
  DrexClient,
  Hit,
  Problems,
  Quote,
  Section,
  Segment,
} from "../contracts.ts";
import { DrexFailure } from "../drex/client.ts";
import { guidance, segmentAsk } from "../prompts/asks.ts";
import { segmenter } from "../segment/choose.ts";
import { inLanes } from "./lanes.ts";
import { note } from "./problems.ts";

// Small requests answer faster and run side by side; one large request serializes a pass.
const ASK_CAP = 24;
const BODY_CAP = 16_000;
const CHOSEN_CAP = 64_000;
const QUOTE_MIN = 0.5;
const KEEP_MIN = 0.25;

type Stop = AbortSignal;

const OPENING_LINES = 12;
const OPENING_BYTES = 1_200;
const BATCH_LANES = 16;

type Job = {
  pickAt: number;
  piece: Segment;
  /** first lines of the document, sent when the segment does not already start there */
  opening: string;
  /** true after one text-halving retry for token-limit */
  trimmed?: boolean;
};

type Bucket = {
  pick: Candidate;
  scored: Map<string, Section>;
  quotes: Quote[];
  quoteKeys: Set<string>;
};

function spanTag(piece: Segment): string {
  return `${piece.rel}:${piece.span.from}-${piece.span.to}`;
}

function entryId(position: number): string {
  return `e${position}`;
}

export type AskBuilder = (
  query: string,
  entry: string,
  title: string,
  spanLabel: string,
  followUp: boolean,
) => Ask;

type Wording = { build: AskBuilder; guidance: string };

const DEFAULT_WORDING: Wording = { build: segmentAsk, guidance: guidance() };

function askFor(query: string, job: Job, position: number, again: boolean, words: Wording): Ask {
  const piece = job.piece;
  const title = piece.title.length > 0 ? piece.title : piece.rel;
  return words.build(query, entryId(position), title, spanTag(piece), again);
}

function asksFor(query: string, jobs: Job[], again: boolean, words: Wording): Ask[] {
  return jobs.map((job, position) => askFor(query, job, position, again, words));
}

function openingOf(doc: Doc): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of doc.body.split("\n")) {
    if (kept.length >= OPENING_LINES) break;
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > OPENING_BYTES) break;
    kept.push(line);
    used += cost;
  }
  return kept.join("\n");
}

function stateOf(query: string, jobs: Job[], words: Wording, chosen?: string): Record<string, unknown> {
  const documents = new Map<
    string,
    { filename: string; opening?: string; segments: Array<Record<string, string>> }
  >();
  jobs.forEach((job, position) => {
    const piece = job.piece;
    let entry = documents.get(piece.rel);
    if (!entry) {
      entry = { filename: piece.rel, segments: [] };
      documents.set(piece.rel, entry);
    }
    if (piece.span.from > 1 && entry.opening === undefined && job.opening.length > 0)
      entry.opening = job.opening;
    entry.segments.push({
      id: entryId(position),
      title: piece.title,
      lines: `${piece.span.from}-${piece.span.to}`,
      text: piece.body,
    });
  });
  const base: Record<string, unknown> = {
    query,
    guidance: words.guidance,
    documents: [...documents.values()],
  };
  if (chosen !== undefined) base.chosen = chosen;
  return base;
}

function bodyBytes(state: unknown, questions: Ask[]): number {
  return Buffer.byteLength(JSON.stringify({ state, questions }), "utf8");
}

function packJobs(
  jobs: Job[],
  query: string,
  again: boolean,
  words: Wording,
  chosen?: string,
): Job[][] {
  const out: Job[][] = [];
  let cur: Job[] = [];
  for (const job of jobs) {
    const trial = cur.concat(job);
    const questions = asksFor(query, trial, again, words);
    const state = stateOf(query, trial, words, chosen);
    const overflow = trial.length > ASK_CAP || bodyBytes(state, questions) > BODY_CAP;
    if (cur.length > 0 && overflow) {
      out.push(cur);
      cur = [job];
    } else {
      cur = trial;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function applyHit(bucket: Bucket, piece: Segment, probability: number): void {
  if (probability >= KEEP_MIN) {
    bucket.scored.set(piece.key, {
      segment: piece.key,
      title: piece.title,
      span: { ...piece.span },
      probability,
    });
  } else {
    bucket.scored.delete(piece.key);
  }

  const key = spanTag(piece);
  if (probability >= QUOTE_MIN) {
    if (!bucket.quoteKeys.has(key)) {
      bucket.quoteKeys.add(key);
      bucket.quotes.push({ ...piece.span, body: piece.body });
    }
  }
}

function chosenBlob(buckets: Bucket[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const bucket of buckets) {
    for (const quote of bucket.quotes) {
      const bytes = Buffer.byteLength(quote.body, "utf8");
      if (used >= CHOSEN_CAP) return parts.join("\n");
      if (used + bytes <= CHOSEN_CAP) {
        parts.push(quote.body);
        used += bytes + (parts.length > 1 ? 1 : 0);
        continue;
      }
      const room = CHOSEN_CAP - used;
      if (room <= 0) return parts.join("\n");
      let cut = quote.body;
      while (Buffer.byteLength(cut, "utf8") > room) {
        cut = cut.slice(0, Math.max(0, cut.length - 1));
      }
      if (cut.length > 0) parts.push(cut);
      return parts.join("\n");
    }
  }
  return parts.join("\n");
}

async function runBatch(
  client: DrexClient,
  query: string,
  jobs: Job[],
  again: boolean,
  stop: Stop,
  buckets: Bucket[],
  problems: Problems,
  words: Wording,
  chosen?: string,
): Promise<void> {
  if (jobs.length === 0) return;
  if (stop.aborted) throw new DrexFailure("cancelled", "aborted");

  const questions = asksFor(query, jobs, again, words);
  const state = stateOf(query, jobs, words, chosen);

  try {
    const verdicts = await client.ask(state, questions, stop);
    const byId = new Map(verdicts.map((v) => [v.tag, v.probability]));
    for (const [position, job] of jobs.entries()) {
      const id = questions[position]!.tag;
      const probability = byId.get(id);
      if (probability === undefined) continue;
      const bucket = buckets[job.pickAt];
      if (!bucket) continue;
      applyHit(bucket, job.piece, probability);
    }
  } catch (err) {
    if (!(err instanceof DrexFailure)) throw err;
    if (err.code === "cancelled") throw err;
    if (err.code === "token-limit") {
      // Drop cross-file follow-up excerpts before any split/shrink.
      if (chosen !== undefined && chosen.length > 0) {
        await runBatch(client, query, jobs, again, stop, buckets, problems, words, undefined);
        return;
      }
      if (jobs.length > 1) {
        const mid = Math.floor(jobs.length / 2);
        await Promise.all(
          [jobs.slice(0, mid), jobs.slice(mid)].map((half) =>
            runBatch(client, query, half, again, stop, buckets, problems, words, undefined),
          ),
        );
        return;
      }
      const only = jobs[0]!;
      if (!only.trimmed && only.piece.body.length > 1) {
        const cut = Math.max(1, Math.floor(only.piece.body.length / 2));
        const shrunk: Job = {
          ...only,
          trimmed: true,
          opening: "",
          piece: { ...only.piece, body: only.piece.body.slice(0, cut) },
        };
        await runBatch(client, query, [shrunk], again, stop, buckets, problems, words, undefined);
        return;
      }
      note(problems, "token-limit", err.message);
      return;
    }
    note(problems, err.code, err.message);
  }
}

async function runPass(
  client: DrexClient,
  query: string,
  jobs: Job[],
  again: boolean,
  stop: Stop,
  buckets: Bucket[],
  problems: Problems,
  words: Wording,
  chosen?: string,
): Promise<void> {
  const batches = packJobs(jobs, query, again, words, chosen);
  await inLanes(batches, BATCH_LANES, (batch) =>
    runBatch(client, query, batch, again, stop, buckets, problems, words, chosen),
  );
}

function toHit(bucket: Bucket): Hit | null {
  const sections = [...bucket.scored.values()];
  if (sections.length === 0 && bucket.quotes.length === 0) return null;
  return {
    rel: bucket.pick.rel,
    sha: bucket.pick.sha,
    rank: bucket.pick.weight,
    via: bucket.pick.via,
    sections,
    quotes: bucket.quotes,
  };
}

export async function judge(args: {
  client: DrexClient;
  docsByPath: Map<string, Doc>;
  picks: Candidate[];
  question: string;
  cancel: Stop;
  followUp?: boolean;
  pickSegments?: (pick: Candidate, all: Segment[]) => Segment[];
  askFor?: AskBuilder;
  guidanceText?: string;
  chosen?: string;
}): Promise<{ hits: Hit[]; problems: Problems }> {
  const cutter = segmenter();
  const words: Wording = {
    build: args.askFor ?? DEFAULT_WORDING.build,
    guidance: args.guidanceText ?? DEFAULT_WORDING.guidance,
  };
  const problems: Problems = {};
  const buckets: Bucket[] = [];
  const passJobs: Job[] = [];

  for (let i = 0; i < args.picks.length; i++) {
    const pick = args.picks[i]!;
    const doc = args.docsByPath.get(pick.rel);
    if (!doc) continue;
    const all = cutter.segments(doc);
    const pieces = args.pickSegments ? args.pickSegments(pick, all) : all;
    const opening = openingOf(doc);
    const at = buckets.length;
    buckets.push({
      pick,
      scored: new Map(),
      quotes: [],
      quoteKeys: new Set(),
    });
    for (const piece of pieces) {
      passJobs.push({ pickAt: at, piece, opening });
    }
  }

  await runPass(
    args.client,
    args.question,
    passJobs,
    false,
    args.cancel,
    buckets,
    problems,
    words,
    args.chosen,
  );

  if (args.followUp !== false) {
    const againJobs: Job[] = [];
    for (const job of passJobs) {
      const bucket = buckets[job.pickAt];
      if (!bucket) continue;
      if (bucket.quotes.length > 0) continue;
      againJobs.push(job);
    }
    if (againJobs.length > 0) {
      const chosen = chosenBlob(buckets);
      await runPass(
        args.client,
        args.question,
        againJobs,
        true,
        args.cancel,
        buckets,
        problems,
        words,
        chosen,
      );
    }
  }

  const hits: Hit[] = [];
  for (const bucket of buckets) {
    const hit = toHit(bucket);
    if (hit) hits.push(hit);
  }

  return { hits, problems };
}
