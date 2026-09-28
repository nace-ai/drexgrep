export type Doc = {
  rel: string; // repo-relative, forward slashes
  size: number;
  sha: string; // sha256 hex of file bytes
  body: string;
};

export type LineSpan = { from: number; to: number }; // 1-based inclusive

export type Segment = {
  key: string;
  rel: string;
  title: string; // heading path or declaration name
  span: LineSpan;
  shape: "heading" | "table" | "prose" | "declaration" | "fallback";
  body: string; // segment body; table row groups keep their header lines
};

export type Ask = { tag: string; prompt: string };
export type Verdict = { tag: string; probability: number }; // 0..1

export type Via = "probe" | "chain" | "survey" | "grep" | "link";
export type Candidate = {
  rel: string;
  sha: string;
  weight: number;
  via: Via;
  matchedShare?: number;
};

export type Section = {
  segment: string;
  title: string;
  span: LineSpan;
  probability: number;
};
export type Quote = LineSpan & { body: string };
export type Hit = {
  rel: string;
  sha: string;
  rank: number; // ordering key, filled by rank.ts
  via: Via;
  sections: Section[];
  quotes: Quote[];
  stale?: boolean; // sha changed before the report was written
};

export type Problems = Record<string, { times: number; note?: string }>;

export type Tally = {
  calls: number;
  retries: number;
  asked: number;
  reused: number;
  docsRead: number;
};

/** finished / had recoverable problems / cancelled mid-run */
export type Outcome = "done" | "partial" | "cancelled";

export type Report = {
  question: string;
  dir: string;
  route: "probe" | "survey" | "code";
  outcome: Outcome;
  hits: Hit[]; // best first
  also: Array<{ rel: string; rank: number }>; // files below the top-K cutoff
  problems: Problems;
  tally: Tally;
};

export interface DrexClient {
  ask(state: unknown, questions: Ask[], stop: AbortSignal): Promise<Verdict[]>;
  readonly calls: number; // successful HTTP 200 calls
  readonly retries: number; // 429 and transient retries
  readonly asked: number;
  readonly reused: number; // verdicts served from the local store
}

export interface Corpus {
  dir: string;
  docs(): Promise<Doc[]>; // eligible files, read once
  outline(doc: Doc): string; // short preview for discovery; may be filled later
  verify(docs: Doc[]): Promise<Set<string>>; // paths whose bytes changed
}

export interface Segmenter {
  segments(doc: Doc): Segment[];
  outline(doc: Doc): string;
}

export type SearchArgs = {
  question: string;
  dir: string;
  cancel: AbortSignal;
  thorough?: boolean;
  topK?: number;
  mode?: SearchMode;
};

export type SearchMode = "auto" | "code" | "docs";
