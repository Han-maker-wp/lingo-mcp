#!/usr/bin/env node
'use strict';

/** End-to-end test: drives the MCP server over stdio exactly as a client would. */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { exactLp } = require('./exact-lp');

const SERVER = path.join(__dirname, '..', 'src', 'index.js');

let passed = 0;
let failed = 0;

function runSession(steps) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let buf = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const fn = pending.get(msg.id);
        if (fn) { pending.delete(msg.id); fn(msg); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });

    let nextId = 1;
    const call = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    (async () => {
      try {
        const out = [];
        for (const step of steps) {
          out.push(await (step === 'init'
            ? call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
            : call('tools/call', step)));
        }
        child.stdin.end();
        resolve({ results: out, stderr });
      } catch (err) {
        child.kill();
        reject(new Error(err.message + '\n--- server stderr ---\n' + stderr));
      }
    })();
  });
}

function parseToolText(res) {
  const text = res.content[0].text;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + err.message);
  }
}

(async () => {
  console.log('lingo-mcp test suite\n');

  let cache = null;
  const steps = ['init',
    { name: 'lingo_status', arguments: {} },
    { name: 'lingo_solve', arguments: { model: 'MAX = 3*X1 + 4*X2 + 2*X3;\nX1 + 2*X2 + X3 <= 30;\nX2 <= 24;\nX3 <= 30;' } },
    { name: 'lingo_solve', arguments: { model: 'MIN = 2*X + 3*Y;\nX + Y >= 10;\nX >= 0;\nY >= 0;' } },
    { name: 'lingo_solve', arguments: { model: 'MAX = X;\nX >= 5;\nX <= 2;' } },
    { name: 'lingo_solve', arguments: { model: 'MAX = X;\nX >= 1;' } },
    { name: 'lingo_solve', arguments: { model: 'MAX = 3*X + 5*Y + 4*Z;\nX + Y + Z <= 10;\n2*X + 3*Y <= 12;\nY + 2*Z <= 11;\nX + Z >= 2;\nX <= 8;\nY <= 7;\nZ <= 6;' } },
    { name: 'lingo_run_commands', arguments: { model: 'MAX = X + 2*Y;\nX + Y <= 4;\nX - Y >= 3;', commands: ['GO', 'RANGE 1'] } },
    { name: 'lingo_list_samples', arguments: { filter: 'ASLBAL' } },
  ];

  cache = await runSession(steps);
  const [init, statusR, solveR, minR, infR, unbR, mixedR, cmdR, samplesR] = cache.results;

  await test('initialize reports server info', () => {
    assert.strictEqual(init.serverInfo.name, 'lingo-mcp');
  });

  const status = parseToolText(statusR);

  await test('lingo_status finds the install and version', () => {
    assert.strictEqual(status.ok, true, JSON.stringify(status));
    assert.ok(status.installDir, 'no installDir reported');
    assert.ok(status.version, 'no version reported: ' + JSON.stringify(status));
  });

  const solved = parseToolText(solveR);

  await test('lingo_solve returns an optimal solution for a MAX model', () => {
    assert.strictEqual(solved.ok, true, JSON.stringify(solved).slice(0, 400));
    assert.strictEqual(solved.status, 'optimal');
  });

  // Cross-check against the independent exact solver rather than a hand-computed number.
  const maxModel = {
    c: [3, 4, 2],
    A: [[1, 2, 1], [0, 1, 0], [0, 0, 1]],
    rel: ['<=', '<=', '<='],
    b: [30, 24, 30],
    sense: 'max',
  };
  const maxExact = exactLp(maxModel);

  await test('lingo_solve objective matches exact enumeration', () => {
    assert.strictEqual(maxExact.status, 'optimal', 'exact solver found no vertex');
    assert.ok(Math.abs(solved.objective - maxExact.value) < 1e-5,
      `LINGO ${solved.objective} vs exact ${maxExact.value}`);
  });

  await test('lingo_solve variable values are a feasible point at the optimum', () => {
    const names = solved.variables.map((v) => v.name);
    for (const n of ['X1', 'X2', 'X3']) assert.ok(names.includes(n), 'missing ' + n + ' in ' + names);
    const x = names.map((n) => solved.variables.find((v) => v.name === n).value);
    // The reported point must satisfy every constraint...
    for (let i = 0; i < maxModel.A.length; i++) {
      const lhs = maxModel.A[i].reduce((s, a, j) => s + a * x[j], 0);
      assert.ok(lhs <= maxModel.b[i] + 1e-6, `row ${i + 1} violated: ${lhs} > ${maxModel.b[i]}`);
    }
    // ...and score exactly the optimum, so LINGO did not merely find a feasible point.
    const score = maxModel.c.reduce((s, cj, j) => s + cj * x[j], 0);
    assert.ok(Math.abs(score - maxExact.value) < 1e-5, `point scores ${score}, optimum ${maxExact.value}`);
  });

  await test('lingo_solve reports every variable with reduced costs', () => {
    for (const v of solved.variables) assert.ok(typeof v.reducedCost === 'number', v.name + ' has no reduced cost');
    assert.strictEqual(solved.variables.length, 3, 'expected 3 variables, got ' + solved.variables.length);
  });

  await test('lingo_solve reports row slacks and dual prices', () => {
    // LINGO numbers the objective function as row 1, so constraints follow from row 2.
    assert.strictEqual(solved.rows.length, 4, 'expected objective + 3 constraints, got ' + solved.rows.length);
    for (const r of solved.rows) assert.ok(typeof r.dualPrice === 'number');
    assert.ok(solved.rows.every((r, i) => r.row === i + 1), 'rows are not sequential');
    assert.ok(Math.abs(solved.rows[0].slackOrSurplus - solved.objective) < 1e-5,
      'row 1 should carry the objective value');
  });

  const minimized = parseToolText(minR);

  await test('lingo_solve handles a MIN model and matches exact enumeration', () => {
    assert.strictEqual(minimized.status, 'optimal', JSON.stringify(minimized).slice(0, 300));
    const exact = exactLp({
      c: [2, 3], A: [[1, 1]], rel: ['>='], b: [10], sense: 'min',
    });
    assert.ok(Math.abs(minimized.objective - exact.value) < 1e-5,
      `LINGO ${minimized.objective} vs exact ${exact.value}`);
  });

  const infeasible = parseToolText(infR);

  await test('lingo_solve detects an infeasible model', () => {
    assert.strictEqual(infeasible.status, 'infeasible', JSON.stringify(infeasible).slice(0, 300));
    assert.strictEqual(infeasible.ok, false, 'infeasible solve must not report ok');
    const exact = exactLp({ c: [1], A: [[1], [1]], rel: ['>=', '<='], b: [5, 2], sense: 'max' });
    assert.strictEqual(exact.status, 'infeasible', 'exact solver disagrees');
  });

  const unbounded = parseToolText(unbR);

  await test('lingo_solve detects an unbounded model', () => {
    assert.strictEqual(unbounded.status, 'unbounded', JSON.stringify(unbounded).slice(0, 300));
  });

  const mixed = parseToolText(mixedR);

  await test('lingo_solve handles a mixed <= / >= model and matches exact enumeration', () => {
    assert.strictEqual(mixed.status, 'optimal', JSON.stringify(mixed).slice(0, 300));
    const exact = exactLp({
      c: [3, 5, 4],
      A: [[1, 1, 1], [2, 3, 0], [0, 1, 2], [1, 0, 1]],
      rel: ['<=', '<=', '<=', '>='],
      b: [10, 12, 11, 2],
      sense: 'max',
    });
    assert.ok(Math.abs(mixed.objective - exact.value) < 1e-5,
      `LINGO ${mixed.objective} vs exact ${exact.value}`);
  });

  const cmds = parseToolText(cmdR);

  await test('lingo_run_commands captures range analysis output', () => {
    const text = cmds.report || cmds.stdout || cmds.raw || '';
    assert.ok(/RANGE|at the level|range/i.test(text), 'no range output: ' + text.slice(0, 200));
  });

  const samples = parseToolText(samplesR);

  await test('lingo_list_samples filters by name', () => {
    assert.strictEqual(samples.ok, true);
    assert.ok(samples.samples.some((s) => /ASLBAL/i.test(s)), JSON.stringify(samples.samples));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
