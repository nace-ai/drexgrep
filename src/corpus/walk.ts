import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import ignoreFactory from "ignore";
import type { Corpus, Doc } from "../contracts.ts";

const BYTE_LIMIT_DEFAULT = 1_000_000;
const ENTRY_LIMIT_DEFAULT = 100_000;
const NUL_WINDOW = 8192;

const SEED_RULES = ["node_modules/", ".git/", "dist/", ".DS_Store"];

type AbortHook = AbortSignal;

export type CorpusOpts = {
  cancel?: AbortHook | undefined;
  fileByteCap?: number;
  entryCap?: number;
};

export type OpenedCorpus = Corpus & { readonly clipped: boolean };

function bailIfCanceled(hook: AbortHook | undefined): void {
  if (!hook || !hook.aborted) return;
  const reason = hook.reason;
  if (reason instanceof Error) throw reason;
  throw new Error("corpus walk canceled");
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function digestHex(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

function decodeUtf8(raw: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(raw);
}

function hasNulPrefix(raw: Uint8Array): boolean {
  const end = Math.min(NUL_WINDOW, raw.byteLength);
  for (let i = 0; i < end; i++) {
    if (raw[i] === 0) return true;
  }
  return false;
}

function previewOutline(doc: Doc): string {
  const kept: string[] = [];
  for (const row of doc.body.split(/\r?\n/)) {
    if (row.trim().length === 0) continue;
    kept.push(row);
    if (kept.length >= 30) break;
  }
  const joined = kept.join("\n");
  return joined.length <= 2000 ? joined : joined.slice(0, 2000);
}

async function buildFilter(absRoot: string) {
  const filter = ignoreFactory();
  filter.add(SEED_RULES);
  try {
    const gitignoreBody = await readFile(path.join(absRoot, ".gitignore"), "utf8");
    filter.add(gitignoreBody);
  } catch {
    // absent .gitignore is fine
  }
  return filter;
}

function isSkippedByFilter(
  filter: ReturnType<typeof ignoreFactory>,
  relPosix: string,
  asDir: boolean,
): boolean {
  if (filter.ignores(relPosix)) return true;
  if (asDir) {
    const withSlash = relPosix.endsWith("/") ? relPosix : `${relPosix}/`;
    if (filter.ignores(withSlash)) return true;
  }
  return false;
}

function byNameAsc(left: Dirent, right: Dirent): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

async function ingestTree(
  absRoot: string,
  filter: ReturnType<typeof ignoreFactory>,
  byteCap: number,
  entryCap: number,
  hook: AbortHook | undefined,
): Promise<{ snapshots: Doc[]; clipped: boolean }> {
  const snapshots: Doc[] = [];
  let clipped = false;

  async function walk(absDir: string): Promise<void> {
    bailIfCanceled(hook);
    if (snapshots.length >= entryCap) {
      clipped = true;
      return;
    }

    const listing = await readdir(absDir, { withFileTypes: true });
    listing.sort(byNameAsc);

    for (const entry of listing) {
      bailIfCanceled(hook);
      if (snapshots.length >= entryCap) {
        clipped = true;
        return;
      }

      const absPath = path.join(absDir, entry.name);
      const relPosix = toPosix(path.relative(absRoot, absPath));
      if (relPosix === "" || relPosix === ".") continue;

      if (entry.isDirectory()) {
        if (isSkippedByFilter(filter, relPosix, true)) continue;
        await walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (isSkippedByFilter(filter, relPosix, false)) continue;

      let size: number;
      try {
        size = (await stat(absPath)).size;
      } catch {
        continue;
      }
      if (size > byteCap) continue;

      let raw: Buffer;
      try {
        raw = await readFile(absPath);
      } catch {
        continue;
      }
      if (raw.byteLength > byteCap) continue;
      if (hasNulPrefix(raw)) continue;

      snapshots.push({
        rel: relPosix,
        size: raw.byteLength,
        sha: digestHex(raw),
        body: decodeUtf8(raw),
      });
    }
  }

  await walk(absRoot);
  return { snapshots, clipped };
}

export async function openCorpus(dir: string, opts: CorpusOpts = {}): Promise<OpenedCorpus> {
  const absRoot = path.resolve(dir);
  const byteCap = opts.fileByteCap ?? BYTE_LIMIT_DEFAULT;
  const entryCap = opts.entryCap ?? ENTRY_LIMIT_DEFAULT;
  bailIfCanceled(opts.cancel);

  const filter = await buildFilter(absRoot);
  const { snapshots, clipped } = await ingestTree(
    absRoot,
    filter,
    byteCap,
    entryCap,
    opts.cancel,
  );

  const cached = snapshots;

  const corpus: OpenedCorpus = {
    dir: absRoot,
    clipped,
    docs: async () => cached,
    outline: (doc) => previewOutline(doc),
    verify: async (docs) => {
      const changed: Set<string> = new Set();
      let i = 0;
      while (i < docs.length) {
        const item = docs[i]!;
        i += 1;
        bailIfCanceled(opts.cancel);
        const absPath = path.join(absRoot, ...item.rel.split("/"));
        let raw: Buffer;
        try {
          raw = await readFile(absPath);
        } catch {
          changed.add(item.rel);
          continue;
        }
        if (digestHex(raw) !== item.sha) changed.add(item.rel);
      }
      return changed;
    },
  };

  return corpus;
}
