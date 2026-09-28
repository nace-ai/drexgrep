import type { Doc } from "../contracts.ts";
import { relOf, rgLines } from "./grep.ts";
import type { DefEntry, DefsForApi, FindDefsApi } from "./types.ts";

const PY_EXT = /\.pyi?$/;
const JS_EXT = /\.(c|m)?(j|t)sx?$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const BATCH = 100;

const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\)?)?/;
const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const PY_ASSIGN = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/;

const JS_FUNCTION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const JS_CLASS = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s*<[^>]*>)?(?:\s+extends\s+([\w$.]+))?/;
const JS_VAR = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/;
const JS_TYPE = /^\s*export\s+(?:declare\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const JS_METHOD = /^\s+(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)?\s*(?::[^{]*)?\{\s*$/;
const JS_KEYWORDS = new Set("if for while switch catch function return with".split(" "));

function baseNames(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b && !b.includes("="))
    .map((b) => b.replace(/\[.*$/, "").split(".").pop()!)
    .filter((b) => IDENT.test(b) && b !== "object");
}

function pythonDefs(rel: string, body: string): DefEntry[] {
  const out: DefEntry[] = [];
  const classes: { name: string; indent: number }[] = [];
  const lines = body.split("\n");
  for (const [n, text] of lines.entries()) {
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.length - text.trimStart().length;
    while (classes.length && classes[classes.length - 1]!.indent >= indent) classes.pop();
    const owner = classes.length ? classes[classes.length - 1]!.name : undefined;
    const c = PY_CLASS.exec(text);
    if (c) {
      out.push({ rel, name: c[2]!, line: n + 1, form: "class", owner, bases: baseNames(c[3]) });
      classes.push({ name: c[2]!, indent });
      continue;
    }
    const d = PY_DEF.exec(text);
    if (d) {
      out.push({ rel, name: d[2]!, line: n + 1, form: "def", owner });
      continue;
    }
    const a = indent === 0 ? PY_ASSIGN.exec(text) : null;
    if (a) out.push({ rel, name: a[1]!, line: n + 1, form: "assign" });
  }
  return out;
}

function jsDefs(rel: string, body: string): DefEntry[] {
  const out: DefEntry[] = [];
  const classes: { name: string; indent: number }[] = [];
  const lines = body.split("\n");
  for (const [n, text] of lines.entries()) {
    if (!text.trim()) continue;
    const indent = text.length - text.trimStart().length;
    if (/^\s*}/.test(text)) {
      while (classes.length && classes[classes.length - 1]!.indent >= indent) classes.pop();
      continue;
    }
    const owner = classes.length ? classes[classes.length - 1]!.name : undefined;
    const c = JS_CLASS.exec(text);
    if (c) {
      out.push({ rel, name: c[1]!, line: n + 1, form: "class", owner, bases: c[2] ? [c[2]!.split(".").pop()!] : [] });
      if (!/}\s*$/.test(text)) classes.push({ name: c[1]!, indent });
      continue;
    }
    const f = JS_FUNCTION.exec(text);
    if (f) {
      out.push({ rel, name: f[1]!, line: n + 1, form: "function", owner });
      continue;
    }
    const v = JS_VAR.exec(text);
    if (v) {
      out.push({ rel, name: v[1]!, line: n + 1, form: indent === 0 ? "assign" : "def", owner });
      continue;
    }
    const t = JS_TYPE.exec(text);
    if (t) {
      out.push({ rel, name: t[1]!, line: n + 1, form: "assign" });
      continue;
    }
    if (owner) {
      const m = JS_METHOD.exec(text);
      if (m && !JS_KEYWORDS.has(m[1]!)) out.push({ rel, name: m[1]!, line: n + 1, form: "def", owner });
    }
  }
  return out;
}

export function defsOf(doc: Doc): DefEntry[] {
  if (PY_EXT.test(doc.rel)) return pythonDefs(doc.rel, doc.body);
  if (JS_EXT.test(doc.rel)) return jsDefs(doc.rel, doc.body);
  return [];
}

export const defsFor: DefsForApi = (docs) => docs.flatMap(defsOf);

function patterns(names: string[]): string[] {
  const alt = names.join("|");
  return [
    `^\\s*(async\\s+)?(class|def)\\s+(${alt})\\b`,
    `^(${alt})\\s*(:[^=]+)?=`,
    `^\\s*(export\\s+)?(default\\s+)?(abstract\\s+)?(async\\s+)?(function\\s*\\*?|class|const|let|var|type|interface|enum)\\s*(${alt})\\b`,
    `^\\s+(static\\s+|async\\s+|public\\s+|private\\s+|protected\\s+)*(${alt})\\s*\\(`,
  ];
}

async function filesViaRg(dir: string, names: string[], cancel: AbortSignal): Promise<Set<string> | null> {
  const rels: Set<string> = new Set();
  for (let i = 0; i < names.length; i += BATCH) {
    const args = ["-l", "--no-messages"];
    for (const p of patterns(names.slice(i, i + BATCH))) args.push("-e", p);
    const lines = await rgLines(dir, args, cancel);
    if (!lines) return null;
    for (const l of lines) rels.add(relOf(l));
  }
  return rels;
}

export const findDefs: FindDefsApi = async (dir, docs, names, cancel) => {
  const wanted = new Set(names.map((n) => n.split(".").pop()!).filter((n) => IDENT.test(n)));
  if (!wanted.size) return [];
  const coded = docs.filter((d) => PY_EXT.test(d.rel) || JS_EXT.test(d.rel));
  const rels = await filesViaRg(dir, [...wanted].map((n) => n.replace(/\$/g, "\\$")), cancel);
  const pool = rels ? coded.filter((d) => rels.has(d.rel)) : coded.filter((d) => [...wanted].some((n) => d.body.includes(n)));
  const out: DefEntry[] = [];
  for (const doc of pool) {
    if (cancel.aborted) throw cancel.reason;
    for (const def of defsOf(doc)) if (wanted.has(def.name)) out.push(def);
  }
  return out;
};
