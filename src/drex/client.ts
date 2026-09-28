import type { Ask, DrexClient, Verdict } from "../contracts.ts";

export type FailureKind = "auth" | "token-limit" | "rate-limit" | "cancelled" | "provider";

export class DrexFailure extends Error {
  readonly code: FailureKind;
  readonly httpCode?: number;
  constructor(kind: FailureKind, message: string, status?: number) {
    super(message);
    this.name = "DrexFailure";
    this.code = kind;
    this.httpCode = status;
  }
}

export type OpenDrexOptions = {
  key: string;
  /** peak parallel HTTP calls (default 64) */
  width?: number | undefined;
  /** optional fetch override for local checks */
  transport?: typeof globalThis.fetch;
  deadlineMs?: number;
};

type QuestionBody = { type: "noul"; instructions: string };

const TOKEN_LIMIT_RE = /token limit|too long|exceeds \d+ tokens/i;
export const DREX_ENDPOINT = "https://drex.nace.ai/v1/systemone";
const DREX_MODEL = "drex-v1.1";
const RATE_ATTEMPTS = 20;
const TRANSIENT_RETRIES = 4;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CAP = 64;
const DEFAULT_START = 8;
const COOLDOWN_DEFAULT_MS = 1000;
const CAUTION_STREAK_FACTOR = 16;

function startLimit(cap: number): number {
  const raw = process.env.DREX_CONCURRENCY;
  const parsed = raw === undefined || raw === "" ? DEFAULT_START : Number(raw);
  const n = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_START;
  return Math.min(Math.max(1, n), cap);
}

function sleep(ms: number, stop: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  const gate = Promise.withResolvers<void>();
  if (stop.aborted) {
    gate.reject(new DrexFailure("cancelled", "aborted"));
    return gate.promise;
  }
  const timer = setTimeout(() => {
    stop.removeEventListener("abort", onAbort);
    gate.resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    gate.reject(new DrexFailure("cancelled", "aborted"));
  };
  stop.addEventListener("abort", onAbort, { once: true });
  return gate.promise;
}

function extractMessage(payload: unknown, fallback: string): string {
  if (payload === null || typeof payload !== "object") return fallback;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.detail === "string" && obj.detail.length > 0) return obj.detail;
  const err = obj.error;
  if (err && typeof err === "object") {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
  return fallback;
}

function classifyHttp(status: number, message: string): DrexFailure {
  const denied = status === 401 || status === 403;
  if (denied) {
    return new DrexFailure("auth", message || `http ${status}`, status);
  }
  if (status === 429) {
    return new DrexFailure("rate-limit", message || "rate limited", status);
  }
  if (status === 422 && TOKEN_LIMIT_RE.test(message)) {
    return new DrexFailure("token-limit", message, status);
  }
  return new DrexFailure("provider", message || `http ${status}`, status);
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return COOLDOWN_DEFAULT_MS;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.ceil(asNumber * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return COOLDOWN_DEFAULT_MS;
}

function buildQuestionMap(questions: Ask[]): Record<string, QuestionBody> {
  const out: Record<string, QuestionBody> = {};
  for (const q of questions) {
    out[q.tag] = { type: "noul", instructions: q.prompt };
  }
  return out;
}

function readVerdicts(payload: unknown, questions: Ask[]): Verdict[] {
  if (payload === null || typeof payload !== "object") {
    throw new DrexFailure("provider", "response missing answers object");
  }
  const answers = (payload as Record<string, unknown>).answers;
  if (answers === null || typeof answers !== "object") {
    throw new DrexFailure("provider", "response missing answers object");
  }
  const map = answers as Record<string, unknown>;
  const verdicts: Verdict[] = [];
  for (const q of questions) {
    const cell = map[q.tag];
    if (cell === null || typeof cell !== "object") {
      throw new DrexFailure("provider", `missing answer for ${q.tag}`);
    }
    const noul = (cell as Record<string, unknown>).noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new DrexFailure("provider", `invalid noul for ${q.tag}`);
    }
    verdicts.push({ tag: q.tag, probability: noul });
  }
  return verdicts;
}

class AdaptiveSlots {
  limit: number;
  readonly cap: number;
  private busy = 0;
  private queue: Array<() => void> = [];
  private streak = 0;
  private caution: number | null = null;
  private waveCut = false;
  private pauseUntil = 0;

  constructor(start: number, cap: number) {
    this.limit = start;
    this.cap = cap;
  }

  markRateLimit(retryMs: number): void {
    this.streak = 0;
    if (!this.waveCut) {
      this.caution = this.limit;
      this.limit = Math.max(1, Math.floor(this.limit / 2));
      this.waveCut = true;
    }
    const until = Date.now() + (retryMs > 0 ? retryMs : COOLDOWN_DEFAULT_MS);
    if (until > this.pauseUntil) this.pauseUntil = until;
  }

  cooldownLeft(): number {
    return Math.max(0, this.pauseUntil - Date.now());
  }

  noteSuccess(ranSaturated: boolean): void {
    if (!ranSaturated) return;
    this.streak += 1;
    const factor =
      this.caution !== null && this.limit >= this.caution ? CAUTION_STREAK_FACTOR : 1;
    const need = this.limit * factor;
    if (this.streak >= need && this.limit < this.cap) {
      this.limit += 1;
      this.streak = 0;
    }
  }

  noteHardFail(): void {
    this.streak = 0;
  }

  async take(stop: AbortSignal): Promise<{ release: () => void; saturated: boolean }> {
    while (true) {
      if (stop.aborted) throw new DrexFailure("cancelled", "aborted");
      const waitMs = this.cooldownLeft();
      if (waitMs > 0) {
        await sleep(waitMs, stop);
        this.waveCut = false;
        continue;
      }
      if (this.busy < this.limit) {
        this.busy += 1;
        const saturated = this.busy >= this.limit;
        return { release: () => this.free(), saturated };
      }
      const turn = Promise.withResolvers<void>();
      const grant = () => {
        stop.removeEventListener("abort", onAbort);
        turn.resolve();
      };
      const onAbort = () => {
        const idx = this.queue.indexOf(grant);
        if (idx >= 0) this.queue.splice(idx, 1);
        turn.reject(new DrexFailure("cancelled", "aborted"));
      };
      this.queue.push(grant);
      stop.addEventListener("abort", onAbort, { once: true });
      await turn.promise;
      // Slot was transferred by free(); do not bump busy again.
      const saturated = this.busy >= this.limit;
      return { release: () => this.free(), saturated };
    }
  }

  private free(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.busy -= 1;
    if (this.busy <= 0) {
      this.busy = 0;
      this.waveCut = false;
    }
  }
}

function canRetryTransient(err: DrexFailure): boolean {
  if (err.code !== "provider") return false;
  if (err.httpCode === undefined) return true;
  return isTransientStatus(err.httpCode);
}

export function openDrex(options: OpenDrexOptions): DrexClient {
  const key = options.key;
  if (!key) throw new Error("key is required");
  const cap =
    options.width !== undefined && Number.isFinite(options.width)
      ? Math.max(1, Math.floor(options.width))
      : DEFAULT_CAP;
  const slots = new AdaptiveSlots(startLimit(cap), cap);
  const doFetch = options.transport ?? fetch;
  const timeoutMs = options.deadlineMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = DREX_ENDPOINT;

  let calls = 0;
  let retries = 0;
  let asked = 0;

  async function postOnce(state: unknown, asks: Ask[], stop: AbortSignal): Promise<Verdict[]> {
    const body: Record<string, unknown> = {
      model: DREX_MODEL,
      state,
      questions: buildQuestionMap(asks),
    };

    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    };

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([stop, timeout]);

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (stop.aborted) throw new DrexFailure("cancelled", "aborted");
      if (err instanceof DrexFailure) throw err;
      const msg = err instanceof Error ? err.message : "network failure";
      throw new DrexFailure("provider", msg);
    }

    let payload: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (response.status === 200) {
      return readVerdicts(payload, asks);
    }

    const message = extractMessage(payload, text || `http ${response.status}`);
    const failure = classifyHttp(response.status, message);
    if (failure.code === "rate-limit") {
      slots.markRateLimit(retryAfterMs(response));
    } else {
      slots.noteHardFail();
    }
    throw failure;
  }

  async function postWithRetries(
    state: unknown,
    asks: Ask[],
    stop: AbortSignal,
    saturated: boolean,
  ): Promise<Verdict[]> {
    let attempt = 0;
    let transientUsed = 0;
    while (true) {
      attempt += 1;
      try {
        const verdicts = await postOnce(state, asks, stop);
        calls += 1;
        asked += asks.length;
        slots.noteSuccess(saturated);
        return verdicts;
      } catch (err) {
        if (!(err instanceof DrexFailure)) throw err;
        if (err.code === "cancelled" || err.code === "auth" || err.code === "token-limit") {
          throw err;
        }
        if (err.code === "rate-limit") {
          if (attempt >= RATE_ATTEMPTS) throw err;
          retries += 1;
          const pause = slots.cooldownLeft();
          await sleep(pause > 0 ? pause : COOLDOWN_DEFAULT_MS, stop);
          continue;
        }
        if (canRetryTransient(err) && transientUsed < TRANSIENT_RETRIES) {
          transientUsed += 1;
          retries += 1;
          await sleep(COOLDOWN_DEFAULT_MS, stop);
          continue;
        }
        throw err;
      }
    }
  }

  return {
    get calls() {
      return calls;
    },
    get retries() {
      return retries;
    },
    get asked() {
      return asked;
    },
    async ask(state, questionList, signal) {
      if (signal.aborted) throw new DrexFailure("cancelled", "aborted");
      if (questionList.length === 0) return [];

      const ticket = await slots.take(signal);
      try {
        return await postWithRetries(state, questionList, signal, ticket.saturated);
      } finally {
        ticket.release();
      }
    },
  };
}
