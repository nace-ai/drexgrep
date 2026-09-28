<p align="center">
  <img src="assets/hero.png" alt="DrexGrep: Drex harness for Context Search" width="820">
</p>

<p align="center">
  <b>Ask a question about a repo. Get the files and lines that answer it.</b><br>
  Local grep finds the candidates. <a href="https://drex.nace.ai">Drex</a> decides what matters.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#output">Output</a>
</p>

---

Give `dg` a bug report or a "where is this implemented?" question, and it returns a short ranked list of files with the exact lines that earned each rank. Your coding agent starts reading in the right place instead of scanning the whole tree.

It is a plain shell command, so it drops into **Codex**, **Claude Code**, **Cursor**, or any agent that can run one.

## Quick start

Requires Git, Node 22+ (with npm), and a Drex API key. Uses [ripgrep](https://github.com/BurntSushi/ripgrep) when it is on `PATH`.

Clone and install the CLI:

```bash
git clone https://github.com/nace-ai/drexgrep.git
cd drexgrep
npm ci && npm run build
npm link                      # puts `dg` and `drexgrep` on PATH
```

[Sign in to Drex](https://drex.nace.ai/) and create an API key in the dashboard. New accounts are created automatically when you sign in. Set the key in your shell:

```bash
export DREX_API_KEY="your-api-key"
```

Try a search over the checkout you just cloned:

```bash
dg "How can I make source files rank higher than documentation in search results?" .
```

Example output (excerpt showing the first two results; scores and ordering can vary between runs):

```text
## src/code/kind.ts  rank=0.29027205866666667  via=grep

## src/code/score.ts  rank=0.2633985105833333  via=grep
```

The first two matches point to file-kind weights and the scoring code that applies them. You can start with a behavior you want to change without knowing its function name. Pass another repository's path instead of `.` to search it, or add `--json` for the [machine-readable report](#output).

Searches require internet access and send your question, file paths, and selected repository content to the hosted Drex API. API usage draws from your account's prepaid credit; see [current pricing and credit terms](https://drex.nace.ai/terms) and the [privacy notice](https://drex.nace.ai/privacy).

## Usage

```bash
dg "question" [root]     # search root (default: current directory)
```

| Flag | What it does |
|---|---|
| `--json` | emit the report as JSON |
| `--top N` | keep N ranked files (default 6) |
| `--thorough` | run the broader discovery pass even when the fast path succeeds |
| `--concurrency N` | parallel Drex requests |

Exit codes: `0` finished · `2` finished with recoverable problems · `130` cancelled · `1` error.

## How it works

```
question ─► names ─► grep + score ─► triage ─► declarations ─► links ─► ranked files
             Drex      local           Drex        Drex          Drex
```

1. **Names.** Pull code names out of the question: identifiers, dotted names, tracebacks, words the repo defines. Drex keeps the ones that belong to the library, not the reporter's own variables.
2. **Grep and score.** Find files that mention those names with `rg`, scored by name rarity, whether the file defines the name, module-path and traceback matches, and file kind (source ahead of tests and docs).
3. **Triage.** Drex reads each candidate's definitions and matched lines and judges whether the reported behavior lives there.
4. **Declarations.** Drex judges only the functions and classes that mention the names, never whole files.
5. **Links.** Follow calls, imports, base classes and sibling overrides from the chosen code; Drex decides which of them matter.

Files are ranked by their strongest judged passage, with the lines behind the rank quoted.

## Output

Text by default. `--json` emits:

```json
{
  "question": "...",
  "dir": "/abs/root",
  "route": "code",
  "outcome": "done",
  "hits": [
    { "rel": "src/a.py", "rank": 0.91, "via": "grep", "sections": [],
      "quotes": [{ "from": 10, "to": 24, "body": "..." }] }
  ],
  "also": [{ "rel": "src/b.py", "rank": 0.4 }],
  "problems": {},
  "tally": { "calls": 43, "retries": 0, "asked": 150, "docsRead": 2831 }
}
```

## Development

```bash
npm run check-types
npm run build
node dist/index.js "question" path/to/root
```
