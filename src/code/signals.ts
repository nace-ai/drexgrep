import type { CodeName, NameOrigin, NamesApi } from "./types.ts";

const LIMIT = 40;

const RANK: Record<NameOrigin, number> = {
  traceback: 0,
  backtick: 1,
  error: 2,
  dotted: 3,
  ident: 4,
  flag: 5,
};

const STOP: ReadonlySet<string> = new Set([
  ..."self cls none true false print import return def class from lambda yield pass raise assert".split(" "),
  ..."np plt pd os sys re ax fig df da ds obj arr x y z args kwargs kw str int float bool list dict".split(" "),
  ..."set tuple type len range object value values data result results output input test tests".split(" "),
  ..."the and for with this that not but are was were you your can will would should could has".split(" "),
  ..."have had does did what when where which why how also then than any all some such etc".split(" "),
  ..."issue bug error problem expected actual behavior behaviour version python code example".split(" "),
  ..."using used use get set new old see like just only one two file files line lines".split(" "),
  ..."traceback most recent call last main http https www com org".split(" "),
]);

const RECEIVERS: ReadonlySet<string> = new Set(
  "ax axs axes fig df da ds np plt pd self obj x y cls arr mod sp tf torch".split(" "),
);

const TLDS = /\.(com|org|net|io|dev|edu|gov|html?|py\.org)$/i;

function junk(t: string): boolean {
  if (t.length < 3) return true;
  if (STOP.has(t.toLowerCase())) return true;
  if (/^[\d._]+$/.test(t)) return true;
  if (/^v?\d+(\.\d+)+\w*$/i.test(t)) return true;
  if (/^[0-9a-f]{7,}$/i.test(t) && /\d/.test(t)) return true;
  if (/^e\.g|^i\.e/i.test(t)) return true;
  return false;
}

function dottedParts(text: string): string[] {
  const bits = text.split(".").filter(Boolean);
  const kept = bits[0] && RECEIVERS.has(bits[0]) ? bits.slice(1) : bits;
  const parts = kept.length > 1 ? [kept.join(".")] : [];
  for (const b of kept) if (!junk(b)) parts.push(b);
  return parts;
}

function stripUrls(q: string): string {
  return q
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/\bwww\.\S+/g, " ")
    .replace(/\S+@\S+\.\w+/g, " ")
    .replace(/\b[\w-]+(\.[\w-]+)*\.(com|org|net|io|dev|edu)\b\S*/gi, " ");
}

export const codeNames: NamesApi = (question) => {
  const found = new Map<string, CodeName>();
  const add = (text: string, parts: string[], origin: NameOrigin, file?: string) => {
    parts = [...new Set(parts.filter((p) => p && !junk(p)))];
    if (!parts.length) return;
    const prev = found.get(text);
    if (prev && RANK[prev.origin] <= RANK[origin]) return;
    found.set(text, file ? { text, parts, origin, file } : { text, parts, origin });
  };
  const addToken = (tok: string, origin: NameOrigin) => {
    tok = tok.replace(/\(.*$/, "").replace(/^[.\s]+|[.,:;()\s]+$/g, "");
    if (!tok || TLDS.test(tok)) return;
    if (tok.includes(".")) {
      if (/^[\w.]+$/.test(tok)) add(tok, dottedParts(tok), origin);
    } else if (/^[A-Za-z_]\w*$/.test(tok)) add(tok, [tok], origin);
  };

  for (const m of question.matchAll(/File "([^"]+)", line (\d+), in (\w+)/g)) {
    const file = m[1]!;
    const func = m[3]!;
    const base = file.split("/").pop()!.replace(/\.\w+$/, "");
    add(file, [func, base], "traceback", file);
  }

  const q = stripUrls(question);

  for (const m of q.matchAll(/`([^`\n]{1,120})`/g)) {
    const span = m[1]!.trim();
    if (/^[\w.]+(\(.*\))?$/.test(span)) addToken(span, "backtick");
    else for (const t of span.match(/[A-Za-z_][\w.]*/g) ?? []) if (/[._]|[a-z][A-Z]/.test(t)) addToken(t, "backtick");
  }

  for (const m of q.matchAll(/\b[A-Z]\w*(Error|Exception|Warning)\b/g)) add(m[0], [m[0]], "error");

  for (const m of q.matchAll(/\b[A-Za-z_]\w*(\.[A-Za-z_]\w*)+/g)) addToken(m[0], "dotted");

  for (const m of q.matchAll(/\b[A-Za-z]\w*\b/g)) {
    const t = m[0];
    const snake = /^_*[a-z][a-z0-9]*(_[a-z0-9]+)+$/i.test(t);
    const camel = /^[A-Z][a-z0-9]+[A-Z]\w*$/.test(t) || /^[a-z]+[A-Z]\w*$/.test(t) || /^[A-Z]{2,}[a-z]\w*$/.test(t);
    if (snake || camel) addToken(t, "ident");
  }
  for (const m of q.matchAll(/\b_\w+\b/g)) addToken(m[0], "ident");

  for (const m of q.matchAll(/(?<![\w-])--[a-z][\w-]+/g)) if (m[0].length > 6 || m[0].includes("-", 2)) add(m[0], [m[0]], "flag");
  for (const m of q.matchAll(/(?<![\w-])[a-z]+(-[a-z]+)+(?![\w-])/g)) {
    if (m[0].length >= 8 && m[0].split("-").length <= 4) add(m[0], [m[0]], "flag");
  }

  return [...found.values()]
    .map((n, i) => ({ n, i }))
    .sort((a, b) => RANK[a.n.origin] - RANK[b.n.origin] || a.i - b.i)
    .slice(0, LIMIT)
    .map(({ n }) => n);
};
