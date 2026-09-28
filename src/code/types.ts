import type { Doc, LineSpan, Segment } from "../contracts.ts";

export type NameOrigin = "backtick" | "dotted" | "ident" | "traceback" | "error" | "flag" | "plain";

export type CodeName = {
  text: string; // as written, e.g. "DataArray.quantile"
  parts: string[]; // searchable pieces, e.g. ["DataArray.quantile", "DataArray", "quantile"]
  origin: NameOrigin;
  file?: string; // traceback path when origin is "traceback"
};

export type GrepHit = {
  rel: string;
  names: Map<string, number[]>; // searched part -> 1-based line numbers
};

export type DefForm = "class" | "def" | "assign" | "function";

export type DefEntry = {
  rel: string;
  name: string;
  line: number; // 1-based
  form: DefForm;
  owner?: string; // enclosing class name
  bases?: string[]; // for classes
};

export type FileKind = "source" | "test" | "example" | "docs" | "changelog" | "data";

export type Scored = {
  rel: string;
  heuristic: number; // 0..1 after normalisation
  kind: FileKind;
  defines: string[]; // kept names this file defines
  windows: LineSpan[]; // matched-line windows to show Drex
};

export type LinkTarget = {
  rel: string;
  name: string;
  line: number;
  reason: "call" | "import" | "base" | "sibling" | "caller";
};

export type NamesApi = (question: string) => CodeName[];
export type KindApi = (doc: Doc) => FileKind;
export type KindWeightApi = (kind: FileKind) => number;
export type GrepApi = (dir: string, docs: Doc[], parts: string[], cancel: AbortSignal) => Promise<GrepHit[]>;
export type DefsForApi = (docs: Doc[]) => DefEntry[];
export type FindDefsApi = (
  dir: string,
  docs: Doc[],
  names: string[],
  cancel: AbortSignal,
) => Promise<DefEntry[]>;
export type LinksFromApi = (chosen: Segment[], docsByPath: Map<string, Doc>) => string[];
export type SiblingsApi = (chosen: Segment[], defs: DefEntry[]) => LinkTarget[];
