#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const lingo = require('./lingo');

const SERVER_NAME = 'lingo-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

function log(msg) {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

function requireInstall() {
  const install = lingo.findInstall();
  if (!install) {
    const e = new Error(
      'LINGO 11 was not found. Install LINGO 11 (default D:\\LINGO11 or C:\\LINGO11) ' +
      'or point the LINGO_HOME environment variable at the install directory.');
    e.code = 'LINGO_NOT_FOUND';
    throw e;
  }
  return install;
}

const TOOLS = [
  {
    name: 'lingo_solve',
    description:
      'Solve a LINGO optimization model and return the structured solution (status, objective value, ' +
      'variable values with reduced costs, row slacks/surplus with dual prices). ' +
      'Accepts LINGO 11 model source inline or a path to a .lng/.lg4 file. ' +
      'The model may be written in plain LINGO 11 syntax; MODEL: and END are added automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'LINGO model source, e.g. "MAX = 3*X1 + 4*X2;\\nX1 + X2 <= 10;\\nX2 <= 6;".',
        },
        file_path: {
          type: 'string',
          description: 'Path to an existing LINGO model file (.lng / .lg4) to solve instead of inline source.',
        },
        nonzero_only: {
          type: 'boolean',
          description: 'Report only nonzero variable values. Default false.',
        },
        timeout_ms: { type: 'number', description: 'Solver timeout in milliseconds. Default 120000.' },
      },
      anyOf: [{ required: ['model'] }, { required: ['file_path'] }],
    },
  },
  {
    name: 'lingo_run_commands',
    description:
      'Run an arbitrary sequence of LINGO command-window commands against a model and return the raw ' +
      'output. Use this for analyses the structured solver does not cover, e.g. ' +
      '["GO", "RANGE 1", "PICTURE 1"]. Commands run after the model is loaded.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'LINGO model source.' },
        file_path: { type: 'string', description: 'Path to a LINGO model file to load instead.' },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'LINGO commands, e.g. ["GO", "SOLU", "RANGE 1", "DUAL 1"].',
        },
        timeout_ms: { type: 'number' },
      },
      required: ['commands'],
    },
  },
  {
    name: 'lingo_status',
    description: 'Report the detected LINGO 11 installation: path, version, license expiry, solver memory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingo_list_samples',
    description: 'List the example models shipped in the LINGO Samples folder, optionally filtered by name.',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Case-insensitive substring to filter sample names.' } },
    },
  },
];

function textResult(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

function errorResult(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: `LINGO error [${err.code || 'ERROR'}]: ${err.message}` }],
  };
}

/** Load model source from an inline string or a file, normalizing it for LINGO 11. */
function loadModelSource(args) {
  if (args.model != null && String(args.model).trim() !== '') {
    return { source: args.model, origin: 'inline' };
  }
  if (args.file_path) {
    const p = path.resolve(args.file_path);
    if (!fs.existsSync(p)) {
      const e = new Error(`Model file not found: ${p}`);
      e.code = 'FILE_NOT_FOUND';
      throw e;
    }
    return { source: fs.readFileSync(p, 'utf8'), origin: p };
  }
  const e = new Error('Either "model" (inline source) or "file_path" must be provided.');
  e.code = 'BAD_ARGS';
  throw e;
}

function solveHandler(args) {
  const install = requireInstall();
  const loaded = loadModelSource(args);
  const { source } = lingo.normalizeModel(loaded.source);

  const workDir = lingo.makeWorkDir();
  const modelPath = path.join(workDir, 'model.lng');
  fs.writeFileSync(modelPath, source.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'latin1');

  const commands = ['GO', args.nonzero_only ? 'NONZ' : 'SOLU'];
  const { lines, reportPath } = lingo.buildScript(modelPath, commands);

  let run;
  try {
    run = lingo.runCommands(install, lines, { workDir, reportPath, timeoutMs: args.timeout_ms });
  } finally {
    if (!args.keep_work_dir) lingo.cleanup(workDir);
  }

  const report = lingo.parseReport(run.report || run.stdout);
  const ok = report.status === 'optimal' || report.status === 'local_optimal' || report.status === 'feasible';

  return textResult({
    ok,
    source: loaded.origin,
    wrapped: true,
    status: report.status,
    statusText: report.statusText,
    objective: report.objective,
    infeasibilities: report.infeasibilities,
    iterations: report.iterations,
    variables: report.variables,
    rows: report.rows,
    errors: report.errors,
    elapsedMs: run.elapsedMs,
    report: run.report || undefined,
    stdout: run.report ? undefined : (run.stdout || undefined),
  });
}

function runCommandsHandler(args) {
  const install = requireInstall();
  const loaded = loadModelSource(args);
  const { source } = lingo.normalizeModel(loaded.source);
  const commands = Array.isArray(args.commands) ? args.commands : [];
  if (commands.length === 0) {
    const e = new Error('"commands" must be a non-empty array of LINGO commands.');
    e.code = 'BAD_ARGS';
    throw e;
  }

  const workDir = lingo.makeWorkDir();
  const modelPath = path.join(workDir, 'model.lng');
  fs.writeFileSync(modelPath, source.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'latin1');

  let run;
  try {
    const { lines, reportPath } = lingo.buildScript(modelPath, commands);
    run = lingo.runCommands(install, lines, { workDir, reportPath, timeoutMs: args.timeout_ms });
  } finally {
    if (!args.keep_work_dir) lingo.cleanup(workDir);
  }

  return textResult({
    ok: run.ok && !/\[Error Code:\s*(?!0)/.test(run.report + run.stdout),
    status: run.status,
    elapsedMs: run.elapsedMs,
    report: run.report,
    stdout: run.report ? undefined : run.stdout,
  });
}

function statusHandler() {
  const install = requireInstall();
  return textResult({ ok: true, ...lingo.probe(install) });
}

function listSamplesHandler(args) {
  const install = requireInstall();
  const dir = path.join(install, 'Samples');
  if (!fs.existsSync(dir)) {
    const e = new Error(`No Samples folder under ${install}`);
    e.code = 'NO_SAMPLES';
    throw e;
  }
  const filter = (args.filter || '').toLowerCase();
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(lg4|lng|ltf)$/i.test(f))
    .filter((f) => !filter || f.toLowerCase().includes(filter));
  return textResult({ ok: true, dir, count: files.length, samples: files });
}

const HANDLERS = {
  lingo_solve: solveHandler,
  lingo_run_commands: runCommandsHandler,
  lingo_status: statusHandler,
  lingo_list_samples: listSamplesHandler,
};

function handleToolCall(params) {
  const handler = HANDLERS[params.name];
  if (!handler) {
    return Promise.resolve(textResult(`Unknown tool: ${params.name}`));
  }
  try {
    return Promise.resolve(handler(params.arguments || {}));
  } catch (err) {
    log(`tool ${params.name} failed: ${err.message}`);
    return Promise.resolve(errorResult(err));
  }
}

function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, messageText) => ({ jsonrpc: '2.0', id, error: { code, message: messageText } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      return handleToolCall(params || {}).then((res) => reply(res));
    default:
      if (id === undefined) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      let res;
      try { res = handle(msg); } catch (err) {
        res = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err && err.message) } };
      }
      Promise.resolve(res).then((r) => {
        if (r && r.id !== undefined) process.stdout.write(JSON.stringify(r) + '\n');
      }).catch((err) => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err && err.message) },
        }) + '\n');
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
