import { createHash } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import type { Ask, Verdict } from "../contracts.ts";

export type StoreRecord = {
  verdicts: Verdict[];
};

export type AnswerStore = {
  get(
    endpoint: string,
    model: string | null,
    state: unknown,
    questions: Ask[],
  ): Promise<Verdict[] | null>;
  put(
    endpoint: string,
    model: string | null,
    state: unknown,
    questions: Ask[],
    verdicts: Verdict[],
  ): Promise<void>;
  clear(): Promise<void>;
  readonly folder: string;
};

function defaultFolder(): string {
  const override = process.env.DREXGREP_CACHE_DIR;
  if (override && override.length > 0) return override;
  return Path.join(Os.homedir(), ".cache", "drexgrep", "v2");
}

function sortValue(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(sortValue);
  const src = input as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    ordered[key] = sortValue(src[key]);
  }
  return ordered;
}

function fingerprint(
  endpoint: string,
  model: string | null,
  state: unknown,
  questions: Ask[],
): string {
  const payload = { endpoint, model, state, questions };
  const text = JSON.stringify(sortValue(payload));
  return createHash("sha256").update(text).digest("hex");
}

function isVerdictList(value: unknown): value is Verdict[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (item === null || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    if (typeof row.tag !== "string") return false;
    if (typeof row.probability !== "number" || !Number.isFinite(row.probability)) return false;
  }
  return true;
}

export function openStore(folder = defaultFolder()): AnswerStore {
  let ready: Promise<void> | null = null;
  const ensure = () => {
    if (!ready) ready = Fs.mkdir(folder, { recursive: true }).then(() => undefined);
    return ready;
  };

  return {
    folder,
    async get(endpoint, model, state, questions) {
      await ensure();
      const name = fingerprint(endpoint, model, state, questions);
      const filePath = Path.join(folder, name);
      let raw: string;
      try {
        raw = await Fs.readFile(filePath, "utf8");
      } catch {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== "object") return null;
        const body = parsed as Record<string, unknown>;
        if (!isVerdictList(body.verdicts)) return null;
        return body.verdicts.map((v) => ({ tag: v.tag, probability: v.probability }));
      } catch {
        return null;
      }
    },
    async put(endpoint, model, state, questions, verdicts) {
      await ensure();
      const name = fingerprint(endpoint, model, state, questions);
      const filePath = Path.join(folder, name);
      const record: StoreRecord = {
        verdicts: verdicts.map((v) => ({ tag: v.tag, probability: v.probability })),
      };
      await Fs.writeFile(filePath, JSON.stringify(record), "utf8");
    },
    async clear() {
      await ensure();
      const names = await Fs.readdir(folder);
      await Promise.all(names.map((name) => Fs.rm(Path.join(folder, name), { force: true })));
    },
  };
}
