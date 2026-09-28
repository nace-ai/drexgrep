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

Requires Node 22+. Uses [ripgrep](https://github.com/BurntSushi/ripgrep) when it is on `PATH`.

```bash
npm ci && npm run build
npm link                      # puts `dg` and `drexgrep` on PATH
export DREX_API_KEY=...

dg "floatformat drops precision for Decimal values" ~/src/django
```

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
