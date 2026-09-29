# lingo-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant solve
optimization models with a locally installed **LINGO 11**, and read the results
back as structured data.

It drives LINGO's own command-line executable (`RunLingo.exe`) with a generated
command script, so answers come from the real LINGO solver — not from a
reimplementation.

- Zero npm dependencies (plain Node.js, stdio JSON-RPC)
- Structured output: status, objective, variable values, reduced costs, row slacks, dual prices
- Recognises infeasible and unbounded outcomes instead of silently reporting a number
- Verified against an independent exact-arithmetic LP solver in the test suite

## Requirements

- Node.js 18 or newer
- LINGO 11 installed. The server looks at, in order: `$LINGO_HOME`, `C:\LINGO11`,
  `D:\LINGO11`, `C:\Program Files\LINGO11`, `C:\Program Files (x86)\LINGO11`,
  `C:\LINGO`, `D:\LINGO`, then the registry.

Only the solver is required. `Lingo11.exe` (the GUI) is not used; if it is missing
the server still works, it just reports `gui: null`.

## Install

```bash
git clone https://github.com/Han-maker-wp/lingo-mcp.git
cd lingo-mcp
node src/index.js          # run it
npm test                   # 13 end-to-end tests against your local LINGO
```

## Register with an MCP client

ZCode / Claude Desktop / mcporter — add to your MCP config:

```json
{
  "mcpServers": {
    "lingo": {
      "command": "node",
      "args": ["C:\\path\\to\\lingo-mcp\\src\\index.js"]
    }
  }
}
```

If LINGO is installed somewhere unusual, set the `LINGO_HOME` environment
variable to that directory.

## Tools

### `lingo_solve`

Solve a model and return the structured solution. Pass `model` (inline LINGO
source) or `file_path` (a `.lng` / `.lg4` file).

```jsonc
// arguments
{
  "model": "MAX = 3*X1 + 4*X2 + 2*X3;\nX1 + 2*X2 + X3 <= 30;\nX2 <= 24;\nX3 <= 30;",
  "nonzero_only": false,       // optional: report only nonzero variables
  "timeout_ms": 120000         // optional
}
```

```jsonc
// result
{
  "ok": true,
  "status": "optimal",                       // optimal | local_optimal | feasible
                                             // | infeasible | unbounded | no_solution | null
  "objective": 90,
  "infeasibilities": 0,
  "iterations": 0,
  "variables": [ { "name": "X1", "value": 30, "reducedCost": 0 }, ... ],
  "rows":     [ { "row": 1, "slackOrSurplus": 90, "dualPrice": 1 }, ... ],
  "errors": [],
  "report": "...raw LINGO output..."
}
```

`ok` is true only when a usable solution came back. An infeasible or unbounded
model is reported as such, with `ok: false` — the tool never invents an optimum.

Row numbering follows LINGO: **row 1 is the objective function**, constraints
start at row 2.

### `lingo_run_commands`

Run arbitrary LINGO command-window commands after loading a model, for analyses
`lingo_solve` does not structure (sensitivity, solution picture, raw rows).

```jsonc
{ "model": "MAX = X + 2*Y;\nX + Y <= 4;\nX - Y >= 3;",
  "commands": ["GO", "RANGE 1", "PICTURE 1"] }
```

### `lingo_status`

Detected install path, LINGO version, license expiry, and solver memory.

### `lingo_list_samples`

List the example models in the LINGO `Samples` folder, with an optional `filter`.

## Notes on driving LINGO 11

These are the behaviours that make scripted LINGO 11 work, each learned the hard
way. They are encoded in `src/lingo.js`.

- **`RunLingo.exe` takes a command script, not a model.**
  `runlingo <script.ltf>` executes a LINGO command script. The command set is a
  small subset of the GUI command window: `MODEL`, `TAKE`, `GO`, `SOLU`, `NONZ`,
  `DIVERT`, `RVRT`, `LOOK`, `RANGE`, `PICTURE`, `DUAL`, `SMPS`, `QUIT`, and so on.
  There is no `OPEN` and no `SOLVE`; loading a file is `TAKE` and solving is `GO`.

- **Command scripts must use CRLF line endings.** With bare LF, LINGO reads the
  whole file as one line and rejects every command as invalid.

- **A model file must start with `MODEL:` and end with `END`.** Without the
  `MODEL:` header, LINGO 11.0 fails to parse the objective line with
  "Invalid input. A syntax error has occurred" — and if the model is left
  completely empty, it instead reports the misleading
  "The model generator ran out of memory". This server wraps bare models
  automatically.

- **`MODEL` is for keyboard input, not files.** It reads a model from stdin.
  Using it on a redirected stdin fails; use `TAKE` for files.

- **Paths in scripts and models may use forward slashes.** Backslashes are fine
  but must be written literally — an escaped `\a`, `\n` or similar in the
  generating layer turns into a control character and LINGO reports a
  misleading "Unable to open file".

- **`DIVERT` must come before the commands whose output you want to keep.**
  Output produced before `DIVERT` goes to the terminal, not the report file.

- **The solution report is printed twice** — once as part of `GO`, once for
  `SOLU`. The parser de-duplicates it, so `variables` and `rows` are not doubled.

- **The evaluation build has a size ceiling** (150 constraints, 300 variables,
  30 integer variables). Larger models fail with error 108; that is a licensing
  limit, not a bug in this server.

- **The GUI (`Lingo11.exe`) needs the Visual C++ 2005 runtime** (`Microsoft.VC80.CRT`
  and `Microsoft.VC80.MFC`, x86). It refuses to start with "its side-by-side
  configuration is incorrect" on a machine without them. The command-line solver
  has no such dependency, so this server does not need them.

## Tests

```bash
npm test
```

The suite spawns the server over stdio exactly as an MCP client would, then
cross-checks every optimal objective against `test/exact-lp.js` — a small
exact-rational LP solver (vertex enumeration over `BigInt` fractions) written
independently of LINGO. Agreement is therefore meaningful rather than a
tautology. It also asserts that the point LINGO reports is actually feasible and
scores exactly the optimum, so a merely-feasible answer cannot pass.

## License

MIT
