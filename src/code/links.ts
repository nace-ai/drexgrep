import type { Segment } from "../contracts.ts";
import type { DefEntry, LinkTarget, LinksFromApi, SiblingsApi } from "./types.ts";

const LINK_CAP = 30;

const COMMON: ReadonlySet<string> = new Set([
  ..."len str int float bool bytes list dict set tuple frozenset object type isinstance issubclass".split(" "),
  ..."super self cls print range enumerate zip map filter sorted reversed min max sum abs any all iter next".split(" "),
  ..."getattr setattr hasattr delattr callable repr hash id open vars dir round divmod".split(" "),
  ..."append extend insert pop remove clear copy update get items keys values setdefault format join split".split(" "),
  ..."strip lstrip rstrip replace startswith endswith lower upper encode decode find index count sort add".split(" "),
  ..."if for while return not and or in is lambda yield assert with elif except raise del await async".split(" "),
  ..."Exception ValueError TypeError KeyError IndexError AttributeError RuntimeError NotImplementedError".split(" "),
  ..."function const let var new typeof instanceof catch switch this require push slice concat then".split(" "),
  ..."log error warn toString String Number Boolean Array Object Promise JSON Math Error Map Set".split(" "),
]);

const CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const FROM_IMPORT = /^\s*from\s+([\w.]+)\s+import\s+\(?([^#\n]+)/gm;
const PLAIN_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const PY_BASES = /^\s*class\s+\w+\s*\(([^)]*)\)/gm;
const JS_EXTENDS = /\bextends\s+([\w$.]+)/g;
const JS_IMPORT = /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s+from/gm;
const DECL_HEAD = /^\s*(?:async\s+)?(?:def|class|function)\s+([A-Za-z_$][\w$]*)/;

export function importedModules(body: string): string[] {
  const mods: Set<string> = new Set();
  for (const m of body.matchAll(FROM_IMPORT)) if (!m[1]!.startsWith(".")) mods.add(m[1]!);
  for (const m of body.matchAll(PLAIN_IMPORT)) for (const p of m[1]!.split(",")) mods.add(p.trim());
  return [...mods];
}

export function moduleRels(module: string, rels: Iterable<string>): string[] {
  const path = module.replace(/\./g, "/");
  const wanted = [`${path}.py`, `${path}/__init__.py`];
  const out: string[] = [];
  for (const rel of rels) if (wanted.some((w) => rel === w || rel.endsWith(`/${w}`))) out.push(rel);
  return out;
}

export function importLinks(chosen: Segment[], rels: string[]): LinkTarget[] {
  const out: LinkTarget[] = [];
  const seen: Set<string> = new Set();
  for (const seg of chosen) {
    for (const mod of importedModules(seg.body)) {
      for (const rel of moduleRels(mod, rels)) {
        if (rel === seg.rel || seen.has(rel)) continue;
        seen.add(rel);
        out.push({ rel, name: mod, line: 1, reason: "import" });
      }
    }
  }
  return out;
}

export const linksFrom: LinksFromApi = (chosen) => {
  const counts = new Map<string, number>();
  const own: Set<string> = new Set();
  const bump = (name: string, by = 1) => {
    const n = name.trim().split(" as ")[0]!.trim().split(".").pop() ?? "";
    if (n.length < 3 || COMMON.has(n) || !/^[A-Za-z_$][\w$]*$/.test(n)) return;
    counts.set(n, (counts.get(n) ?? 0) + by);
  };
  for (const seg of chosen) {
    const head = DECL_HEAD.exec(seg.body);
    if (head) own.add(head[1]!);
    for (const m of seg.body.matchAll(CALL)) bump(m[1]!);
    for (const m of seg.body.matchAll(FROM_IMPORT)) for (const p of m[2]!.replace(/[()\\]/g, "").split(",")) bump(p, 2);
    for (const m of seg.body.matchAll(PLAIN_IMPORT)) for (const p of m[1]!.split(",")) bump(p, 2);
    for (const m of seg.body.matchAll(JS_IMPORT)) for (const p of m[1]!.split(",")) bump(p, 2);
    for (const m of seg.body.matchAll(PY_BASES)) for (const b of m[1]!.split(",")) if (!b.includes("=")) bump(b, 3);
    for (const m of seg.body.matchAll(JS_EXTENDS)) bump(m[1]!, 3);
  }
  for (const n of own) counts.delete(n);
  return [...counts]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, LINK_CAP)
    .map(([n]) => n);
};

export const siblingOverrides: SiblingsApi = (chosen, defs) => {
  const classes = new Map<string, DefEntry>();
  const byName = new Map<string, DefEntry[]>();
  for (const d of defs) {
    if (d.form === "class") classes.set(`${d.rel}\0${d.name}`, d);
    else if (d.owner) {
      const list = byName.get(d.name);
      if (list) list.push(d);
      else byName.set(d.name, [d]);
    }
  }
  const out: LinkTarget[] = [];
  const seen: Set<string> = new Set();
  for (const seg of chosen) {
    const method = defs.find(
      (d) => d.rel === seg.rel && d.owner && d.form !== "class" && d.line >= seg.span.from && d.line <= seg.span.to,
    );
    if (!method?.owner) continue;
    const bases = new Set(classes.get(`${seg.rel}\0${method.owner}`)?.bases ?? []);
    for (const other of byName.get(method.name) ?? []) {
      if (other.rel === seg.rel || !other.owner) continue;
      const otherBases = classes.get(`${other.rel}\0${other.owner}`)?.bases ?? [];
      const related =
        other.owner === method.owner ||
        bases.has(other.owner) ||
        otherBases.includes(method.owner) ||
        otherBases.some((b) => bases.has(b));
      const key = `${other.rel}:${other.line}`;
      if (!related || seen.has(key)) continue;
      seen.add(key);
      out.push({ rel: other.rel, name: `${other.owner}.${other.name}`, line: other.line, reason: "sibling" });
    }
  }
  return out;
};
