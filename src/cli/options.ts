import type { SearchMode } from "../contracts.ts";

export type SearchFlags = {
  action: "search";
  question: string;
  dir: string;
  asJson: boolean;
  topK: number;
  thorough: boolean;
  mode: SearchMode;
  skipCache: boolean;
  parallel?: number;
};

export type ParsedCli =
  | { action: "help" }
  | { action: "version" }
  | { action: "doctor" }
  | { action: "cache-clear" }
  | SearchFlags;

const DEFAULT_TOP = 6;

function readPositiveInt(raw: string, flag: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw || n < 1) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return n;
}

export function parseArgv(argv: string[]): ParsedCli {
  const flags = {
    asJson: false,
    topK: DEFAULT_TOP,
    thorough: false,
    mode: "auto" as SearchMode,
    skipCache: false,
    parallel: undefined as number | undefined,
    help: false,
    version: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (token === "--version") {
      flags.version = true;
      continue;
    }
    if (token === "--json") {
      flags.asJson = true;
      continue;
    }
    if (token === "--thorough") {
      flags.thorough = true;
      continue;
    }
    if (token === "--no-cache") {
      flags.skipCache = true;
      continue;
    }
    if (token === "--top" || token.startsWith("--top=")) {
      const raw =
        token === "--top" ? argv[++i] : token.slice("--top=".length);
      if (raw === undefined) throw new Error("--top needs a value");
      flags.topK = readPositiveInt(raw, "--top");
      continue;
    }
    if (token === "--concurrency" || token.startsWith("--concurrency=")) {
      const raw =
        token === "--concurrency"
          ? argv[++i]
          : token.slice("--concurrency=".length);
      if (raw === undefined) throw new Error("--concurrency needs a value");
      flags.parallel = readPositiveInt(raw, "--concurrency");
      continue;
    }
    if (token === "--mode" || token.startsWith("--mode=")) {
      const raw = token === "--mode" ? argv[++i] : token.slice("--mode=".length);
      if (raw === undefined) throw new Error("--mode needs a value");
      if (raw !== "auto" && raw !== "code" && raw !== "docs") {
        throw new Error("--mode expects auto, code or docs");
      }
      flags.mode = raw;
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`unknown flag: ${token}`);
    }
    positionals.push(token);
  }

  if (flags.help) return { action: "help" };
  if (flags.version) return { action: "version" };

  const head = positionals[0];
  if (head === "doctor") {
    if (positionals.length > 1) throw new Error("doctor takes no arguments");
    return { action: "doctor" };
  }
  if (head === "cache") {
    if (positionals[1] !== "clear" || positionals.length !== 2) {
      throw new Error("usage: dg cache clear");
    }
    return { action: "cache-clear" };
  }
  if (!head?.trim()) {
    throw new Error('usage: dg "question" [root]');
  }
  if (positionals.length > 2) {
    throw new Error('usage: dg "question" [root]');
  }

  const treeRoot =
    positionals.length >= 2 ? String(positionals[1]) : process.cwd();

  return {
    action: "search",
    question: head,
    dir: treeRoot,
    asJson: flags.asJson,
    topK: flags.topK,
    thorough: flags.thorough,
    mode: flags.mode,
    skipCache: flags.skipCache,
    ...(flags.parallel === undefined ? {} : { parallel: flags.parallel }),
  };
}

export const USAGE = `dg — ask a question over a local tree

Usage:
  dg "question" [root]
  dg doctor
  dg cache clear

Root defaults to the current working directory.

Flags:
  --json           emit the report as JSON on stdout
  --top N          keep N ranked files (default ${DEFAULT_TOP})
  --thorough       ask the pipeline for a deeper pass
  --mode M         route: auto, code or docs (default auto)
  --no-cache       set DREXGREP_NO_CACHE=1 for this run
  --concurrency N  set DREX_CONCURRENCY for this run
  --help, -h       show this text
  --version        print package version
`;
