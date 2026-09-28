import type { Candidate, Doc, Hit, Problems, Report, SearchArgs } from "../contracts.ts";
import { openCorpus } from "../corpus/walk.ts";
import { DrexFailure, openDrex } from "../drex/client.ts";
import {
  chainCandidates,
  freshIds,
  matchDocs,
  probeLimits,
  termsIn,
} from "../probe/terms.ts";
import { codeRoute, definedWords, sourceShare } from "../code/route.ts";
import { codeNames } from "../code/signals.ts";
import type { CodeName } from "../code/types.ts";
import { judge } from "./judge.ts";
import { rank, type RankResult } from "./rank.ts";
import { fold } from "./problems.ts";
import { survey } from "./survey.ts";

function emptyReport(
  dir: string,
  question: string,
  outcome: Report["outcome"],
  route: Report["route"] = "probe",
): Report {
  return {
    question,
    dir,
    route,
    outcome,
    hits: [],
    also: [],
    problems: {},
    tally: { calls: 0, retries: 0, asked: 0, reused: 0, docsRead: 0 },
  };
}

function raiseAuth(problems: Problems): void {
  const denied = problems.auth;
  if (!denied) return;
  throw new DrexFailure("auth", denied.note ?? "auth failed");
}

function hasQuote(rows: Hit[]): boolean {
  for (const row of rows) {
    if (row.quotes.length > 0) return true;
  }
  return false;
}

function sliceLines(body: string, from: number, to: number): string {
  const rows = body.split(/\r?\n/);
  const lo = Math.max(0, from - 1);
  const hi = Math.min(rows.length, to);
  if (lo >= hi) return "";
  return rows.slice(lo, hi).join("\n");
}

function donorText(rows: Hit[], docs: Map<string, Doc>): string {
  const fromQuotes: string[] = [];
  for (const row of rows) {
    for (const quote of row.quotes) {
      if (quote.body) fromQuotes.push(quote.body);
    }
  }
  if (fromQuotes.length > 0) return fromQuotes.join("\n");

  const fromSegs: string[] = [];
  for (const row of rows) {
    const doc = docs.get(row.rel);
    if (!doc) continue;
    for (const sec of row.sections) {
      const chunk = sliceLines(doc.body, sec.span.from, sec.span.to);
      if (chunk) fromSegs.push(chunk);
    }
  }
  return fromSegs.join("\n");
}

function pathIndex(docs: Doc[]): Map<string, Doc> {
  const map = new Map<string, Doc>();
  for (const doc of docs) map.set(doc.rel, doc);
  return map;
}

const CODE_SHARE = 0.4;

async function pickRoute(input: SearchArgs, dir: string, docs: Doc[]): Promise<CodeName[] | null> {
  const mode = input.mode ?? "auto";
  if (mode === "docs") return null;
  if (mode === "auto" && sourceShare(docs) < CODE_SHARE) return null;
  const names = codeNames(input.question);
  if (names.length === 0) names.push(...(await definedWords(input.question, dir, docs, input.cancel)));
  if (mode === "auto" && names.length === 0) return null;
  return names;
}

export async function search(input: SearchArgs): Promise<Report> {
  const halt = input.cancel;
  if (halt.aborted) {
    return emptyReport(input.dir, input.question, "cancelled");
  }

  const key = process.env.DREX_API_KEY;
  if (!key || !key.trim()) throw new Error("Set DREX_API_KEY.");

  const corpus = await openCorpus(input.dir, { cancel: halt });
  const docs = await corpus.docs();
  const byPath = pathIndex(docs);

  const client = openDrex({
    key,
    remember: process.env.DREXGREP_NO_CACHE !== "1",
    width: Number(process.env.DREX_CONCURRENCY || 16),
  });

  let route: Report["route"] = "probe";
  let hits: Hit[] = [];
  const problemBags: Problems[] = [];
  const judged = new Set<string>();
  const knownIds = new Set<string>();

  const finish = async (hint?: Report["outcome"], preRanked?: RankResult): Promise<Report> => {
    const ranked = preRanked ?? rank({ hits, topK: input.topK });
    hits = ranked.hits;
    const also = ranked.also;

    const check: Doc[] = [];
    for (const row of hits) {
      const doc = byPath.get(row.rel);
      if (doc) check.push(doc);
    }
    if (check.length > 0 && !halt.aborted) {
      try {
        const changed = await corpus.verify(check);
        for (const row of hits) {
          if (changed.has(row.rel)) row.stale = true;
        }
      } catch {
        if (!halt.aborted) throw new Error("corpus verify failed");
      }
    }

    const problems = fold(problemBags);
    let outcome: Report["outcome"] = "done";
    if (halt.aborted || hint === "cancelled") outcome = "cancelled";
    else if (Object.keys(problems).length > 0) outcome = "partial";

    return {
      question: input.question,
      dir: corpus.dir,
      route,
      outcome,
      hits,
      also,
      problems,
      tally: tallyOf(),
    };
  };

  const tallyOf = () => ({
    calls: client.calls,
    retries: client.retries,
    asked: client.asked,
    reused: client.reused,
    docsRead: docs.length,
  });

  try {
    const names = await pickRoute(input, corpus.dir, docs);
    if (names) {
      route = "code";
      const coded = await codeRoute({
        client,
        dir: corpus.dir,
        docs,
        docsByPath: byPath,
        question: input.question,
        names,
        cancel: halt,
        topK: input.topK,
      });
      for (const bag of coded.problems) {
        raiseAuth(bag);
        problemBags.push(bag);
      }
      hits = coded.hits;
      return await finish(undefined, coded.ranked);
    }

    const terms = termsIn(input.question);
    for (const term of terms) knownIds.add(term.value);

    let probeHits: Hit[] = [];
    let probeHitCount = 0;

    if (terms.length > 0) {
      const matched = matchDocs(docs, terms, probeLimits.files);
      probeHitCount = matched.length;
      if (matched.length >= 1 && matched.length <= probeLimits.files) {
        for (const pick of matched) judged.add(pick.rel);
        const first = await judge({
          client,
          docsByPath: byPath,
          picks: matched,
          question: input.question,
          cancel: halt,
        });
        raiseAuth(first.problems);
        problemBags.push(first.problems);
        probeHits = first.hits;
        hits = probeHits;

        let frontier = probeHits;
        for (let hop = 0; hop < probeLimits.hops; hop++) {
          if (halt.aborted) break;
          const blob = donorText(frontier, byPath);
          if (!blob) break;
          const ids = freshIds(blob, knownIds);
          for (const id of ids) knownIds.add(id);
          if (ids.length === 0) break;

          const linked: Candidate[] = chainCandidates(docs, ids, judged);
          if (linked.length === 0) break;
          for (const pick of linked) judged.add(pick.rel);

          const next = await judge({
            client,
            docsByPath: byPath,
            picks: linked,
            question: input.question,
            cancel: halt,
            followUp: true,
          });
          raiseAuth(next.problems);
          problemBags.push(next.problems);
          if (next.hits.length === 0) break;
          probeHits = probeHits.concat(next.hits);
          hits = probeHits;
          frontier = next.hits;
        }
      }
    }

    const usable = hasQuote(probeHits);
    const hitShapeBad =
      terms.length === 0 || probeHitCount === 0 || probeHitCount > probeLimits.files;
    const wantSurvey = !usable || !!input.thorough || hitShapeBad;

    hits = probeHits;

    if (wantSurvey) {
      route = "survey";
      const surveyed = await survey({
        client,
        docs,
        question: input.question,
        cancel: halt,
      });
      raiseAuth(surveyed.problems);
      problemBags.push(surveyed.problems);

      const fresh = surveyed.picks.filter((pick) => !judged.has(pick.rel));
      if (fresh.length > 0) {
        for (const pick of fresh) judged.add(pick.rel);
        const judgedSurvey = await judge({
          client,
          docsByPath: byPath,
          picks: fresh,
          question: input.question,
          cancel: halt,
        });
        raiseAuth(judgedSurvey.problems);
        problemBags.push(judgedSurvey.problems);
        hits = probeHits.concat(judgedSurvey.hits);
      }
    }

    return await finish();
  } catch (err) {
    if (err instanceof DrexFailure && err.code === "auth") throw err;
    if (
      (err instanceof DrexFailure && err.code === "cancelled") ||
      halt.aborted
    ) {
      if (hits.length > 0) return await finish("cancelled");
      return {
        ...emptyReport(corpus.dir, input.question, "cancelled", route),
        tally: tallyOf(),
        problems: fold(problemBags),
        hits,
      };
    }
    throw err;
  }
}
