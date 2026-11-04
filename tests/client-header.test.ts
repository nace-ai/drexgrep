import assert from "node:assert/strict";
import { test } from "node:test";
import { openDrex } from "../src/drex/client.ts";
import { CLIENT_ID } from "../src/version.ts";

test("every Drex request carries X-Nace-Client and a matching User-Agent", async () => {
  const seen: Headers[] = [];
  const transport: typeof fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ answers: { a: { noul: 0.5 } } }), { status: 200 });
  };
  const client = openDrex({ key: "test-key", transport });
  await client.ask({}, [{ tag: "a", prompt: "p" }], new AbortController().signal);

  assert.equal(seen.length, 1);
  const header = seen[0]!.get("x-nace-client");
  assert.equal(header, CLIENT_ID);
  assert.equal(seen[0]!.get("user-agent"), CLIENT_ID);
  assert.match(header!, /^drexgrep\/\d+\.\d+\.\d+/);
  assert.ok(header!.length <= 64);
  assert.match(header!, /^[A-Za-z0-9 ._@+-]+\/[A-Za-z0-9 ._@+-]+$/);
});
