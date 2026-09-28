import { readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Report } from "../contracts";
import { search } from "../pipeline/run";
import { renderJson, renderText } from "../report/emit";
import { USAGE, parseArgv, type SearchFlags } from "./options";

function writeOut(text: string): void {
  writeSync(1, text.endsWith("\n") ? text : `${text}\n`);
}

function writeErr(text: string): void {
  writeSync(2, text.endsWith("\n") ? text : `${text}\n`);
}

function packageVersion(): string {
  const entry = process.argv[1] ? resolve(process.argv[1]) : process.cwd();
  const base = dirname(entry);
  for (const rel of ["../package.json", "package.json", "../../package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(join(base, rel), "utf8")) as {
        version?: string;
      };
      if (parsed.version) return parsed.version;
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}

function requireApiKey(): void {
  if (!process.env.DREX_API_KEY) {
    throw new Error("Set DREX_API_KEY.");
  }
}

function applyRunEnv(flags: SearchFlags): void {
  if (flags.parallel !== undefined) {
    process.env.DREX_CONCURRENCY = String(flags.parallel);
  }
}

function emitStats(report: Report): void {
  if (process.env.DREXGREP_STATS !== "1") return;
  const payload = { ...report.tally, route: report.route };
  writeErr(`DREXGREP_STATS ${JSON.stringify(payload)}`);
}

function exitFor(outcome: Report["outcome"]): number {
  if (outcome === "done") return 0;
  if (outcome === "partial") return 2;
  return 130;
}

async function runSearch(flags: SearchFlags): Promise<number> {
  if (process.env.DREXGREP_ABLATE !== "heuristic") requireApiKey();
  applyRunEnv(flags);

  const halt = new AbortController();
  const stop = () => halt.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    const report = await search({
      question: flags.question,
      dir: flags.dir,
      cancel: halt.signal,
      thorough: flags.thorough,
      topK: flags.topK,
      mode: flags.mode,
    });
    emitStats(report);
    const body = flags.asJson
      ? renderJson(report)
      : renderText(report, flags.topK);
    writeOut(body);
    return exitFor(report.outcome);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function launch(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(message);
    return 1;
  }

  if (parsed.action === "help") {
    writeOut(USAGE);
    return 0;
  }
  if (parsed.action === "version") {
    writeOut(packageVersion());
    return 0;
  }
  return runSearch(parsed);
}

const code = await launch().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  writeErr(message);
  return 1;
});
process.exit(code);
