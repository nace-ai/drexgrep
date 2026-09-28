import type { Doc, Segment } from "../contracts.ts";
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

const TOP_FROM = /^from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm;
const TOP_PLAIN = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
const WORD = /[A-Za-z_$][\w$]*/g;
const UPPER = /(?<![\w$.])([A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Z]{4,})(?![\w$])/g;
const ATTR = /\.([a-z_][a-z0-9_]{4,})(?![\w$]*\s*\()/g;
const FAMILY_MIN = 3;
const PY_FILE = /\.pyi?$/;
const FAMILY_FILES = 6;

function wordsOf(body: string): Set<string> {
  return new Set(body.match(WORD) ?? []);
}

function absoluteModule(mod: string, rel: string): string {
  const dots = /^\.*/.exec(mod)![0].length;
  if (dots === 0) return mod;
  const dirs = rel.split("/").slice(0, -1);
  const base = dirs.slice(0, Math.max(0, dirs.length - (dots - 1)));
  const rest = mod.slice(dots);
  return [...base, ...(rest ? [rest] : [])].join(".");
}

function lineOf(doc: Doc | undefined, name: string): number {
  if (!doc || !/^\w+$/.test(name)) return 0;
  const re = new RegExp(`^\\s*(?:(?:async\\s+)?(?:def|class)\\s+${name}\\b|${name}\\s*(?::[^=\\n]+)?=(?!=))`, "m");
  const m = re.exec(doc.body);
  return m ? doc.body.slice(0, m.index).split("\n").length : 0;
}

export function headerImports(chosen: Segment[], docsByPath: Map<string, Doc>): { used: LinkTarget[]; loose: LinkTarget[] } {
  const rels = [...docsByPath.keys()];
  const out: LinkTarget[] = [];
  const loose: LinkTarget[] = [];
  const seen: Set<string> = new Set();
  const looseSeen: Set<string> = new Set();
  for (const seg of chosen) {
    const doc = docsByPath.get(seg.rel);
    if (!doc || !/\.pyi?$/.test(seg.rel)) continue;
    const used = wordsOf(seg.body);
    const add = (rel: string, name: string) => {
      if (rel === seg.rel || seen.has(`${rel}\0${name}`)) return;
      seen.add(`${rel}\0${name}`);
      const line = lineOf(docsByPath.get(rel), name);
      out.push({ rel, name, line: line || 1, reason: "import" });
    };
    for (const m of doc.body.matchAll(TOP_FROM)) {
      const mod = absoluteModule(m[1]!, seg.rel);
      for (const piece of m[2]!.replace(/[()\\]/g, " ").split(",")) {
        const [orig, alias] = piece.trim().split(/\s+as\s+/);
        if (!orig) continue;
        const name = orig.trim();
        const whole = mod ? `${mod}.${name}` : name;
        const found = moduleRels(whole, rels);
        const files = found.length ? found : mod ? moduleRels(mod, rels) : [];
        if (used.has((alias ?? orig).trim())) for (const rel of files) add(rel, name);
        else for (const rel of files) if (rel !== seg.rel && !looseSeen.has(rel) && looseSeen.add(rel)) loose.push({ rel, name, line: lineOf(docsByPath.get(rel), name) || 1, reason: "import" });
      }
    }
    for (const m of doc.body.matchAll(TOP_PLAIN)) {
      const handle = m[2] ?? m[1]!;
      if (!seg.body.includes(`${handle}.`)) continue;
      for (const rel of moduleRels(m[1]!, rels)) add(rel, m[1]!);
    }
  }
  return { used: out, loose };
}

export function nameUses(chosen: Segment[]): { constants: string[]; attrs: string[] } {
  const constants: Set<string> = new Set();
  const attrs: Set<string> = new Set();
  for (const seg of chosen) {
    for (const m of seg.body.matchAll(UPPER)) constants.add(m[1]!);
    for (const m of seg.body.matchAll(ATTR)) if (!COMMON.has(m[1]!)) attrs.add(m[1]!);
  }
  return { constants: [...constants], attrs: [...attrs] };
}

export function ownFunctions(chosen: Segment[]): Map<string, string> {
  const out: Map<string, string> = new Map();
  for (const seg of chosen) {
    const head = DECL_HEAD.exec(seg.body);
    const name = head?.[1];
    if (name && name.length >= 4 && !COMMON.has(name) && !name.startsWith("__")) out.set(name, seg.rel);
  }
  return out;
}

export function callSites(doc: Doc, name: string, lines: number[]): number[] {
  const text = doc.body.split("\n");
  const call = new RegExp(`(?<![\\w$])${name}\\s*\\(`);
  const decl = new RegExp(`^\\s*(?:async\\s+)?(?:def|function)\\s+${name}\\b`);
  return lines.filter((n) => call.test(text[n - 1] ?? "") && !decl.test(text[n - 1] ?? ""));
}

export function familyLinks(chosen: Segment[], docsByPath: Map<string, Doc>): LinkTarget[] {
  const byDir: Map<string, string[]> = new Map();
  for (const rel of docsByPath.keys()) {
    const cut = rel.lastIndexOf("/");
    const d = cut < 0 ? "" : rel.slice(0, cut);
    const list = byDir.get(d);
    if (list) list.push(rel);
    else byDir.set(d, [rel]);
  }
  const out: LinkTarget[] = [];
  const seen: Set<string> = new Set();
  for (const seg of chosen) {
    const parts = seg.rel.split("/");
    if (parts.length < 3) continue;
    const file = parts[parts.length - 1]!;
    const parent = parts.slice(0, -2).join("/");
    const own = parts.slice(0, -1).join("/");
    const members = [...byDir.keys()].filter(
      (d) => d !== own && d.startsWith(`${parent}/`) && !d.slice(parent.length + 1).includes("/") && docsByPath.has(`${d}/${file}`),
    );
    const common = new Set(
      (byDir.get(own) ?? []).map((r) => r.slice(own.length + 1)).filter((n) => PY_FILE.test(n) && n !== "__init__.py"),
    );
    const shared = (d: string) => [...common].filter((n) => docsByPath.has(`${d}/${n}`)).length;
    const family = members.filter((d) => shared(d) >= FAMILY_MIN);
    if (family.length < 2) continue;
    const used = [...new Set([...seg.body.matchAll(ATTR)].map((m) => m[1]!))].filter((w) => w.length >= 6 && !COMMON.has(w));
    if (used.length === 0) continue;
    const found: { rel: string; names: [string, number][] }[] = [];
    const spread = new Map<string, number>();
    for (const d of [own, ...family]) {
      for (const rel of byDir.get(d) ?? []) {
        const name = rel.slice(d.length + 1);
        if (rel === seg.rel || seen.has(rel) || !common.has(name)) continue;
        const doc = docsByPath.get(rel)!;
        const names: [string, number][] = [];
        for (const w of used) {
          const line = doc.body.includes(w) ? lineOf(doc, w) : 0;
          if (!line) continue;
          names.push([w, line]);
          spread.set(w, (spread.get(w) ?? 0) + 1);
        }
        if (names.length) found.push({ rel, names });
      }
    }
    const limit = family.length;
    const ranked = found
      .map((f) => ({ ...f, names: f.names.filter(([w]) => spread.get(w)! < limit) }))
      .filter((f) => f.names.length > 0)
      .sort((x, y) => y.names.length - x.names.length || (x.rel < y.rel ? -1 : 1))
      .slice(0, FAMILY_FILES);
    for (const f of ranked) {
      seen.add(f.rel);
      for (const [w, line] of f.names.slice(0, 2)) out.push({ rel: f.rel, name: w, line, reason: "sibling" });
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
