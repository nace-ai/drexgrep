import type { Hit, LineSpan, Quote, Section } from "../contracts.ts";

export type RankArgs = {
  hits: Hit[];
  topK?: number;
  quoteMin?: number;
  keepMin?: number;
};

export type RankResult = {
  hits: Hit[];
  also: Array<{ rel: string; rank: number }>;
};

type HitExtras = Hit & { matchedShare?: number };

function spanKey(span: LineSpan): string {
  return `${span.from}:${span.to}`;
}

function bestSectionProb(sections: Section[]): number {
  let best = 0;
  for (const sec of sections) {
    if (sec.probability > best) best = sec.probability;
  }
  return best;
}

function shareOf(hit: Hit): number {
  const extra = hit as HitExtras;
  return typeof extra.matchedShare === "number" ? extra.matchedShare : 0;
}

function keptQuotes(hit: Hit, quoteMin: number): Quote[] {
  const allowed: Record<string, true> = Object.create(null);
  for (const sec of hit.sections) {
    if (sec.probability >= quoteMin) allowed[spanKey(sec.span)] = true;
  }
  const kept: Quote[] = [];
  for (const quote of hit.quotes) {
    if (!allowed[spanKey(quote)]) continue;
    if (!quote.body) continue;
    kept.push(quote);
  }
  return kept;
}

const QUOTE_CAP = 3;

export function rank(args: RankArgs): RankResult {
  const topK = args.topK ?? 6;
  const quoteMin = args.quoteMin ?? 0.6;
  const keepMin = args.keepMin ?? 0.3;

  type Row = { hit: Hit; peak: number; inbound: number; share: number; order: number };
  const rows: Row[] = [];
  for (const raw of args.hits) {
    const peak = bestSectionProb(raw.sections);
    if (peak < keepMin && raw.rank < keepMin) continue;
    const inbound = raw.rank;
    rows.push({
      hit: raw,
      peak,
      inbound,
      share: shareOf(raw),
      order: peak > inbound ? peak : inbound,
    });
  }

  rows.sort((a, b) => {
    if (b.order !== a.order) return b.order - a.order;
    if (b.peak !== a.peak) return b.peak - a.peak;
    if (b.share !== a.share) return b.share - a.share;
    if (a.hit.rel < b.hit.rel) return -1;
    if (a.hit.rel > b.hit.rel) return 1;
    return 0;
  });

  const shaped: Hit[] = rows.map((row) => ({
    ...row.hit,
    rank: row.order,
    quotes: keptQuotes(row.hit, quoteMin).slice(0, QUOTE_CAP),
  }));

  const head = shaped.slice(0, topK);
  const also = shaped.slice(topK).map((h) => ({ rel: h.rel, rank: h.rank }));
  return { hits: head, also };
}

const KIND_FLOOR = 0.05;

export function rankCode(args: {
  hits: Hit[];
  triage: Map<string, number>;
  kindWeight: Map<string, number>;
  topK?: number;
  quoteMin?: number;
}): RankResult {
  const topK = args.topK ?? 6;
  const quoteMin = args.quoteMin ?? 0.6;

  type Row = { hit: Hit; score: number; peak: number; kind: number };
  const all: Row[] = args.hits.map((hit) => {
    const peak = bestSectionProb(hit.sections);
    const kind = args.kindWeight.get(hit.rel) ?? 1;
    const triage = args.triage.get(hit.rel) ?? 0;
    return { hit, peak, kind, score: peak * (0.5 + 0.5 * triage) * kind };
  });
  const strong = all.filter((row) => row.kind > KIND_FLOOR);
  const rows = strong.length > 0 ? strong : all;

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.peak !== a.peak) return b.peak - a.peak;
    if (a.hit.rel < b.hit.rel) return -1;
    if (a.hit.rel > b.hit.rel) return 1;
    return 0;
  });

  const shaped: Hit[] = rows.map((row) => ({
    ...row.hit,
    rank: row.score,
    quotes: keptQuotes(row.hit, quoteMin).slice(0, QUOTE_CAP),
  }));

  const head = shaped.slice(0, topK);
  const also = shaped.slice(topK).map((h) => ({ rel: h.rel, rank: h.rank }));
  return { hits: head, also };
}
