'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 120000;

/** Places LINGO 11 has been seen to install to, most likely first. */
const CANDIDATE_DIRS = [
  'C:\\LINGO11',
  'D:\\LINGO11',
  'C:\\Program Files\\LINGO11',
  'C:\\Program Files (x86)\\LINGO11',
  'C:\\Program Files\\LINDO',
  'C:\\Program Files (x86)\\LINDO',
  'C:\\LINGO',
  'D:\\LINGO',
  'C:\\Program Files\\LINGO',
  'C:\\Program Files (x86)\\LINGO',
];

function isLingoDir(dir) {
  try {
    return fs.existsSync(path.join(dir, 'RunLingo.exe')) ||
           fs.existsSync(path.join(dir, 'Lingo11.exe'));
  } catch {
    return false;
  }
}

function fromRegistry() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\LINDO\\Lingo',
    'HKLM\\SOFTWARE\\LINDO\\Lingo',
    'HKCU\\SOFTWARE\\LINDO\\Lingo',
  ];
  for (const key of keys) {
    try {
      const out = require('child_process').execSync(
        `reg query "${key}" /v InstallDir`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/InstallDir\s+REG_\w+\s+(.+)/i);
      if (m) return m[1].trim();
    } catch { /* key absent */ }
  }
  return null;
}

/** Resolve the LINGO install directory, or null when LINGO is not installed. */
function findInstall() {
  const fromEnv = process.env.LINGO_HOME || process.env.LINGO_DIR;
  if (fromEnv && isLingoDir(fromEnv)) return path.resolve(fromEnv);
  for (const dir of CANDIDATE_DIRS) {
    if (isLingoDir(dir)) return dir;
  }
  const reg = fromRegistry();
  if (reg && isLingoDir(reg)) return path.resolve(reg);
  return null;
}

function exeOf(install, name) {
  const p = path.join(install, name);
  return fs.existsSync(p) ? p : null;
}

/** Banner text LINGO prints on startup; used to strip noise from stdout. */
function stripBanner(stdout) {
  const lines = stdout.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*(Compiling model|Global optimal|Local optimal|Solution is|Unbounded|Model is|\[Error Code)/.test(l));
  return idx === -1 ? stdout : lines.slice(idx).join('\n');
}

/**
 * LINGO 11 only parses an objective section when the model is opened through
 * its set-based syntax, i.e. the file must start with MODEL: and end with END.
 * Wrap bare models so callers can paste plain LINGO 11 syntax.
 */
function normalizeModel(src) {
  let text = String(src).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const firstMeaningful = lines.find((l) => l.trim() && !l.trim().startsWith('!'));
  const hasModel = !!firstMeaningful && /^\s*model\s*:/i.test(firstMeaningful);
  const hasEnd = lines.some((l) => /^\s*end\s*$/i.test(l.trim()) && l.trim().length <= 4);
  const body = text.replace(/^\s*MODEL\s*:\s*$/im, '').replace(/^\s*END\s*$/im, '');
  return {
    source: ['MODEL:', body.replace(/^\n+|\n+$/g, ''), 'END', ''].join('\n'),
    wrapped: !hasModel || !hasEnd,
  };
}

function toLingoPath(p) {
  return p.replace(/\\/g, '/');
}

let runCounter = 0;

function makeWorkDir() {
  const base = path.join(os.tmpdir(), 'lingo-mcp');
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, `run-${process.pid}-${Date.now()}-${runCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Compose a LINGO command script: load the model, divert all subsequent output
 * to a report file, run the caller's commands, then restore output and quit.
 * DIVERT comes first so the report captures everything the commands emit.
 */
function buildScript(modelPath, commands) {
  const reportPath = modelPath.replace(/\.lng$/i, '') + '.report.txt';
  const lines = [
    `TAKE ${toLingoPath(modelPath)}`,
    `DIVERT ${toLingoPath(reportPath)}`,
    ...commands,
    'RVRT',
    'QUIT',
  ];
  return { lines, reportPath };
}

/**
 * Drive RunLingo.exe with a LINGO command script.
 * `commands` is the exact command list to run, in order.
 * Returns { ok, stdout, report, status, timedOut, elapsedMs }.
 */
function runCommands(install, commands, opts = {}) {
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const workDir = opts.workDir || makeWorkDir();
  const scriptPath = path.join(workDir, 'script.ltf');
  const scriptRel = toLingoPath(scriptPath);

  fs.writeFileSync(scriptPath, commands.join(CRLF) + CRLF, 'latin1');

  const runLingo = exeOf(install, 'RunLingo.exe');
  const exe = runLingo || exeOf(install, 'Lingo11.exe');
  if (!exe) {
    cleanup(workDir);
    const err = new Error('RunLingo.exe not found under ' + install);
    err.code = 'LINGO_EXE_MISSING';
    throw err;
  }

  const started = Date.now();
  const res = spawnSync(exe, [scriptRel], {
    cwd: install,
    encoding: 'latin1',
    timeout,
    windowsHide: true,
    input: '',
    maxBuffer: 32 * 1024 * 1024,
  });

  let report = '';
  try { report = fs.readFileSync(opts.reportPath || '', 'latin1'); } catch { /* no report written */ }
  return {
    ok: !res.error && res.status === 0,
    timedOut: !!(res.error && res.error.code === 'ETIMEDOUT'),
    status: res.status,
    stdout: stripBanner(res.stdout || ''),
    stderr: res.stderr || '',
    error: res.error ? String(res.error.message) : null,
    report,
    elapsedMs: Date.now() - started,
    scriptPath,
    reportPath: opts.reportPath || null,
  };
}

const STATUS_MAP = [
  [/Global optimal solution found/i, 'optimal'],
  [/Local optimal solution found/i, 'local_optimal'],
  [/Feasible point found/i, 'feasible'],
  [/No feasible solution found/i, 'infeasible'],
  [/Solution is infeasible/i, 'infeasible'],
  [/Model is infeasible/i, 'infeasible'],
  [/Unbounded solution/i, 'unbounded'],
  [/Model is unbounded/i, 'unbounded'],
  [/No solution/i, 'no_solution'],
];

/** LINGO error codes that describe the outcome rather than a failure. */
const BENIGN_ERROR_CODES = new Set([
  81,   // no feasible solution found
  82,   // unbounded solution
  92,   // warning: current solution may be nonoptimal/infeasible
  105,  // model is infeasible
  106,  // model is unbounded
]);

/** Parse a LINGO solution report into a structured object. */
function parseReport(text) {
  const out = {
    status: null,
    statusText: null,
    objective: null,
    infeasibilities: null,
    iterations: null,
    variables: [],
    rows: [],
    errors: [],
    raw: text,
  };
  if (!text) return out;

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;

    for (const [re, name] of STATUS_MAP) {
      if (re.test(t)) { out.status = name; out.statusText = t; break; }
    }
    let m = t.match(/^Objective value:\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/i);
    if (m) { out.objective = Number(m[1]); continue; }
    m = t.match(/^Infeasibilities:\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/i);
    if (m) { out.infeasibilities = Number(m[1]); continue; }
    m = t.match(/^Total solver iterations:\s*(\d+)/i);
    if (m) { out.iterations = Number(m[1]); continue; }

    m = t.match(/^\[Error Code:\s*(-?\d+)\]\s*$/i);
    if (m) {
      const code = Number(m[1]);
      out.errors.push({ code, message: null, benign: BENIGN_ERROR_CODES.has(code) });
      continue;
    }

    if (/^Variable\b.*\bValue\b.*\bReduced Cost\b/i.test(t)) continue;
    if (/^Row\b.*\bSlack or Surplus\b.*\bDual Price\b/i.test(t)) continue;

    // A report row is a bare LINGO identifier (optionally indexed) plus two numbers.
    // Requiring the identifier shape keeps prose lines like "Structural analysis, pass 1"
    // from being mistaken for variables.
    m = t.match(/^([A-Za-z][A-Za-z0-9_]*(?:\([^)]*\))?)\s+(-?[\d.]+(?:[eE][-+]?\d+)?)\s+(-?[\d.]+(?:[eE][-+]?\d+)?)\s*$/);
    if (m) {
      // GO already prints a solution report and SOLU prints it again; keep one copy.
      if (!out.variables.some((v) => v.name === m[1])) {
        out.variables.push({ name: m[1], value: Number(m[2]), reducedCost: Number(m[3]) });
      }
      continue;
    }
    m = t.match(/^(\d+)\s+(-?[\d.]+(?:[eE][-+]?\d+)?)\s+(-?[\d.]+(?:[eE][-+]?\d+)?)\s*$/);
    if (m) {
      const row = Number(m[1]);
      if (!out.rows.some((r) => r.row === row)) {
        out.rows.push({ row, slackOrSurplus: Number(m[2]), dualPrice: Number(m[3]) });
      }
      continue;
    }
    if (out.errors.length && out.errors[out.errors.length - 1].message === null) {
      out.errors[out.errors.length - 1].message = t;
    }
  }
  return out;
}

/** Read version / license facts from a RunLingo run. */
function probe(install, opts = {}) {
  const workDir = makeWorkDir();
  try {
    const exe = exeOf(install, 'RunLingo.exe') || exeOf(install, 'Lingo11.exe');
    const scriptPath = path.join(workDir, 'probe.ltf');
    fs.writeFileSync(scriptPath, 'MEM' + CRLF + 'QUIT' + CRLF, 'latin1');
    const res = spawnSync(exe, [toLingoPath(scriptPath)], {
      cwd: install, encoding: 'latin1', timeout: opts.timeoutMs || 60000,
      windowsHide: true, input: '', maxBuffer: 8 * 1024 * 1024,
    });
    const text = `${res.stdout || ''}${res.stderr || ''}`;
    const version = text.match(/LINGO\/WIN32\s+([\d.]+)/i);
    const license = text.match(/License expires:\s*(.+)/i);
    const generatorMemory = text.match(/Total generator memory\s+(\d+)/i);
    return {
      installDir: install,
      runLingo: exeOf(install, 'RunLingo.exe'),
      gui: exeOf(install, 'Lingo11.exe'),
      version: version ? version[1] : null,
      licenseExpires: license ? license[1].trim() : null,
      generatorMemoryBytes: generatorMemory ? Number(generatorMemory[1]) : null,
      banner: text.split(/\r?\n/).slice(0, 2).join(' ').trim(),
    };
  } finally {
    cleanup(workDir);
  }
}

module.exports = {
  findInstall, probe, runCommands, buildScript, parseReport, normalizeModel, toLingoPath, stripBanner,
  DEFAULT_TIMEOUT_MS, makeWorkDir, cleanup,
};
