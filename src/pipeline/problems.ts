import type { Problems } from "../contracts.ts";

export function note(bag: Problems, code: string, detail?: string): void {
  const seen = bag[code];
  if (!seen) {
    bag[code] = detail === undefined ? { times: 1 } : { times: 1, note: detail };
    return;
  }
  seen.times += 1;
  if (detail !== undefined && seen.note === undefined) seen.note = detail;
}

export function fold(bags: Problems[]): Problems {
  const out: Problems = {};
  for (const bag of bags) {
    for (const [code, seen] of Object.entries(bag)) {
      const have = out[code];
      if (!have) {
        out[code] = { ...seen };
        continue;
      }
      have.times += seen.times;
      if (seen.note !== undefined && have.note === undefined) have.note = seen.note;
    }
  }
  return out;
}
