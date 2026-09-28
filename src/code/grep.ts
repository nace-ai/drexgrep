import * as childProcess from "node:child_process";
import type { Doc } from "../contracts.ts";
import type { GrepApi, GrepHit } from "./types.ts";

const BATCH = 150;

let rgState: boolean | undefined;

export function rgAvailable(): boolean | undefined {
  return rgState;
}

// Resolves null when rg cannot be spawned or exits with an error (exit 1 just means no match).
export function rgLines(dir: string, args: string[], cancel: AbortSignal): Promise<string[] | null> {
  if (rgState === false) return Promise.resolve(null);
  return new Promise<string[] | null>((done, fail) => {
    if (cancel.aborted) return fail(cancel.reason);
    const child = childProcess.spawn("rg", [...args, "."], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    const out: string[] = [];
    let tail = "";
    const onAbort = () => child.kill();
    cancel.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const pieces = (tail + chunk).split("\n");
      tail = pieces.pop() ?? "";
      for (const p of pieces) if (p) out.push(p);
    });
    child.on("error", () => {
      cancel.removeEventListener("abort", onAbort);
      rgState = false;
      done(null);
    });
    child.on("close", (code) => {
      cancel.removeEventListener("abort", onAbort);
      if (cancel.aborted) return fail(cancel.reason);
      if (tail) out.push(tail);
      if (code === 0 || code === 1) {
        rgState = true;
        done(out);
      } else done(null);
    });
  });
}

export function relOf(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function wordRe(part: string, flags = ""): RegExp {
  return new RegExp(`(?<![\\w])${escapeRe(part)}(?![\\w])`, flags);
}

function record(hits: Map<string, Map<string, number[]>>, rel: string, part: string, line: number): void {
  let names = hits.get(rel);
  if (!names) hits.set(rel, (names = new Map()));
  const lines = names.get(part);
  if (!lines) names.set(part, [line]);
  else if (lines[lines.length - 1] !== line) lines.push(line);
}

async function viaRg(
  dir: string,
  known: Set<string>,
  parts: string[],
  tests: Map<string, RegExp>,
  cancel: AbortSignal,
): Promise<Map<string, Map<string, number[]>> | null> {
  const hits = new Map<string, Map<string, number[]>>();
  for (let i = 0; i < parts.length; i += BATCH) {
    const batch = parts.slice(i, i + BATCH);
    const args = "--json -F -w --no-messages".split(" ");
    for (const p of batch) args.push("-e", p);
    const lines = await rgLines(dir, args, cancel);
    if (!lines) return null;
    for (const raw of lines) {
      let msg: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.type !== "match" || !msg.data?.path?.text || !msg.data.line_number) continue;
      const rel = relOf(msg.data.path.text);
      if (!known.has(rel)) continue;
      const text = msg.data.lines?.text ?? "";
      for (const p of batch) if (tests.get(p)!.test(text)) record(hits, rel, p, msg.data.line_number);
    }
  }
  return hits;
}

function inMemory(docs: Doc[], parts: string[], tests: Map<string, RegExp>, cancel: AbortSignal) {
  const hits = new Map<string, Map<string, number[]>>();
  for (const doc of docs) {
    if (cancel.aborted) throw cancel.reason;
    const present = parts.filter((p) => doc.body.includes(p));
    if (!present.length) continue;
    const lines = doc.body.split("\n");
    for (const [n, text] of lines.entries()) {
      for (const p of present) if (tests.get(p)!.test(text)) record(hits, doc.rel, p, n + 1);
    }
  }
  return hits;
}

export const grepNames: GrepApi = async (dir, docs, parts, cancel) => {
  const unique = [...new Set(parts.filter((p) => p.trim()))];
  if (!unique.length) return [];
  const tests = new Map(unique.map((p) => [p, wordRe(p)]));
  const known = new Set(docs.map((d) => d.rel));
  const hits = (await viaRg(dir, known, unique, tests, cancel)) ?? inMemory(docs, unique, tests, cancel);
  const out: GrepHit[] = [];
  for (const [rel, names] of hits) out.push({ rel, names });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
};
