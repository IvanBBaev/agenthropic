// Timing aid for docs/measurement/time-to-understand-protocol.md — the v1.0 exit-gate
// clause "<30s to understand a session", which no test can close because it is a claim
// about a human.
//
// It does NOT instrument the UI. It prints a question to a terminal, times the gap
// between two Enter presses, and afterwards reads ground truth from the same public
// read API a `curl` would use. The dashboard never learns it is being measured, so
// the thing measured is the thing shipped.
//
//   node scripts/time-to-understand.mjs select
//   node scripts/time-to-understand.mjs run <sessionId> --label S1
//
// The token is read from DASHBOARD_TOKEN, sent to loopback only, and never printed.
// Nothing here writes anywhere except the measurement log; ~/.claude/projects is read
// by the server, read-only, and never touched by this script at all.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const LOG_PATH = fileURLToPath(
  new URL('../docs/measurement/time-to-understand-log.md', import.meta.url),
);
const DEFAULT_BASE = 'http://127.0.0.1:4317';
const TARGET_SECONDS = 30;

/** The token must never leave the machine: loopback origins only, no exceptions. */
function resolveBase() {
  const raw = process.env['DASHBOARD_URL'] ?? DEFAULT_BASE;
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.host.split(':')[0])) {
    throw new Error(`Refusing to send DASHBOARD_TOKEN to non-loopback host "${url.hostname}".`);
  }
  return url.origin;
}

function resolveToken() {
  const token = process.env['DASHBOARD_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error('DASHBOARD_TOKEN is not set — export the same token the server booted with.');
  }
  return token;
}

// Resolved on first use, not at import time, so `--help` and a typo in the mode
// still print usage instead of a credentials error.
let base = '';
let token = '';

function connect() {
  base = resolveBase();
  token = resolveToken();
}

/** @param {string} path @returns {Promise<{ok: true, body: any} | {ok: false, status: number}>} */
async function api(path) {
  const response = await globalThis.fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, body: await response.json() };
}

/** @param {string} path */
async function apiOrThrow(path) {
  const result = await api(path);
  if (!result.ok) throw new Error(`GET ${path} → HTTP ${result.status}`);
  return result.body;
}

/** @param {string} id */
const short = (id) => String(id).slice(0, 8);

/** @param {number} usd */
const usd = (amount) => `$${Number(amount).toFixed(4)}`;

// ---------------------------------------------------------------------------
// select — the fixed session-picking rule (protocol §2). Prints ids and NOTHING
// else about them, so reading the selection cannot pre-answer a question.
// ---------------------------------------------------------------------------

async function select() {
  connect();
  const { sessions } = await apiOrThrow('/api/sessions?limit=200');
  if (sessions.length === 0) {
    console.log('No sessions in the database. Let ingest run first.');
    return;
  }
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const byCostRecent = sessions
    .filter((s) => (s.lastActivityAt ?? '') >= weekAgo)
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  const byStart = sessions
    .filter((s) => s.startedAt !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));

  /** @type {[string, string, any[], (s: any) => boolean][]} */
  const rules = [
    ['S1', 'most recent session with >= 5 agents', sessions, (s) => s.agentCount >= 5],
    ['S2', 'highest-cost session in the last 7 days', byCostRecent, () => true],
    [
      'S3',
      'a session with an error or unknown agent',
      sessions,
      (s) => s.statusCounts.error + s.statusCounts.unknown > 0,
    ],
    ['S4', 'the oldest session still in the database', byStart, () => true],
    ['S5', 'a session with exactly one agent', sessions, (s) => s.agentCount === 1],
  ];

  // A session is burnt once it has been timed (protocol §3, rule 7), so no slot
  // may reuse one another slot already claimed - it falls through to the next
  // candidate its own rule allows, or to "no such session".
  const chosen = new Set();
  const picks = rules.map(([slot, rule, pool, matches]) => {
    const session = pool.find((s) => matches(s) && !chosen.has(s.id));
    if (session !== undefined) chosen.add(session.id);
    return [slot, rule, session];
  });
  const practice = sessions.find((s) => !chosen.has(s.id));

  console.log('\nSession selection (protocol §2) — ids only, deliberately.\n');
  console.log(`  P   ${practice?.id ?? '(none left — run the practice on any session)'}`);
  console.log('      practice, recorded, excluded from the gate\n');
  for (const [slot, rule, session] of picks) {
    console.log(
      `  ${slot}  ${session?.id ?? '(no such session — record "no such session"; the absence is data)'}`,
    );
    console.log(`      ${rule}\n`);
  }
  console.log('Do not open any of these before the clock starts.');
  console.log(`Then: node scripts/time-to-understand.mjs run <sessionId> --label S1\n`);
}

// ---------------------------------------------------------------------------
// run — one trial.
// ---------------------------------------------------------------------------

const SESSION_ITEMS = [
  {
    id: 'Q1',
    ask: 'Q1 — How many agents are in this session, and which branch is still running?',
    format: '<N> agents; running: <id prefixes | none>',
  },
  {
    id: 'Q2',
    ask: 'Q2 — Which agent burned the most tokens, and what did it cost?',
    format: '<agent id prefix | unattributed>; $<amount>',
  },
  {
    id: 'Q3s',
    ask: 'Q3s — Did THIS session get stuck or error?',
    format: 'clean | stuck: <id prefixes>',
  },
];

const FLEET_ITEMS = [
  {
    id: 'Q3f',
    ask: 'Q3f — Did ANY session get stuck or error without you noticing?',
    format: 'none | <session id prefixes>',
  },
  {
    id: 'Q4',
    ask: 'Q4 — What did today and this week cost, and how much did delegation save?',
    format: 'today $<x>; week $<y>; savings $<z | not shown>',
  },
];

const Q5 = {
  id: 'Q5',
  ask: 'Q5 — Which sessions from last night are listed, now that the server has restarted?',
  format: '<N> sessions from <date>, ids <prefixes>',
};

/**
 * One timed item. The clock stops when the operator KNOWS the answer, not when
 * they have finished typing it — typing speed is not what the gate is about.
 */
async function timeItem(rl, item) {
  console.log(`\n${item.ask}`);
  console.log(`  answer as: ${item.format}`);
  await rl.question('  [Enter] to start — look at the screen only AFTER you press it: ');
  const startedAt = Date.now();
  await rl.question('  [Enter] the moment you know the answer: ');
  const seconds = (Date.now() - startedAt) / 1000;
  const answer = await rl.question('  Type it now, WITHOUT looking back at the screen: ');
  console.log(`  → ${seconds.toFixed(1)} s`);
  return { id: item.id, seconds, answer: answer.trim() };
}

/** Ground truth for every item, read from the API after the clocks have stopped. */
async function groundTruth(sessionId, sessionsBefore, sessionsAfter) {
  const tree = await apiOrThrow(`/api/sessions/${encodeURIComponent(sessionId)}/tree`);
  const cost = await apiOrThrow('/api/cost/summary');
  const analysis = await api(`/api/sessions/${encodeURIComponent(sessionId)}/cost-analysis`);

  const working = tree.agents.filter((a) => a.status === 'working').map((a) => short(a.id));
  const stuck = tree.agents
    .filter((a) => a.status === 'error' || a.status === 'unknown')
    .map((a) => short(a.id));
  const topAgent = [...tree.agents].sort((a, b) => b.totalTokens - a.totalTokens)[0];
  const burner =
    topAgent === undefined || tree.unattributed.totalTokens > topAgent.totalTokens
      ? `unattributed; ${usd(tree.unattributed.costUsd)} (${tree.unattributed.totalTokens} tokens)`
      : `${short(topAgent.id)}; ${usd(topAgent.costUsd)} (${topAgent.totalTokens} tokens)`;

  const today = new Date().toISOString().slice(0, 10);
  const todayRow = cost.perDay.find((d) => d.day === today);
  const week = cost.perDay
    .filter((d) => d.day !== 'unknown')
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, 7)
    .reduce((sum, d) => sum + d.costUsd, 0);
  const savings = analysis.ok
    ? `${usd(analysis.body.delegationSavings.savingsUsd)} (estimate; API only — no view calls this endpoint)`
    : `not available (HTTP ${analysis.status})`;

  const fleetStuck = sessionsAfter
    .filter((s) => s.statusCounts.error + s.statusCounts.unknown > 0)
    .map((s) => short(s.id));

  const idsBefore = new Set(sessionsBefore.map((s) => s.id));
  const survived = sessionsAfter.filter((s) => idsBefore.has(s.id)).length;
  const lost = sessionsBefore
    .filter((s) => !sessionsAfter.some((a) => a.id === s.id))
    .map((s) => short(s.id));

  return {
    Q1: `${tree.agentCount} agents; working: ${working.join(', ') || 'none'}`,
    Q2: burner,
    Q3s: stuck.length === 0 ? 'clean' : `stuck: ${stuck.join(', ')}`,
    Q3f: fleetStuck.length === 0 ? 'none' : fleetStuck.join(', '),
    Q4: `today ${usd(todayRow?.costUsd ?? 0)}${todayRow ? '' : ' (no row for today)'}; last 7 recorded days ${usd(week)}; savings ${savings}`,
    Q5: `${sessionsAfter.length} sessions after restart; ${survived} of ${sessionsBefore.length} survived${lost.length ? `; LOST: ${lost.join(', ')}` : ''}`,
  };
}

async function run(sessionId, label) {
  connect();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nTrial ${label} — session ${sessionId}`);
    console.log('Rules (protocol §3): browser on #/live, freshly reloaded, and you are');
    console.log('NOT looking at it. No devtools, no curl, no SQL during a timed item.');
    await rl.question('\n[Enter] when the browser is ready and you are looking at this terminal: ');

    const results = [];
    for (const item of SESSION_ITEMS) results.push(await timeItem(rl, item));
    const tSession = results.reduce((sum, r) => sum + r.seconds, 0);
    console.log(`\nT_session = ${tSession.toFixed(1)} s (target < ${TARGET_SECONDS} s)`);

    for (const item of FLEET_ITEMS) results.push(await timeItem(rl, item));

    const sessionsBefore = (await apiOrThrow('/api/sessions?limit=200')).sessions;
    console.log('\nQ5 needs a restart. Stop the server (Ctrl-C), start it again, and');
    console.log('reload the browser. Restart time is NOT on the clock.');
    await rl.question('[Enter] once the reloaded page is in front of you: ');
    results.push(await timeItem(rl, Q5));
    const sessionsAfter = (await apiOrThrow('/api/sessions?limit=200')).sessions;

    const truth = await groundTruth(sessionId, sessionsBefore, sessionsAfter);
    console.log('\n--- Grading. You decide; this script only shows you the data. ---');
    for (const result of results) {
      console.log(`\n${result.id}`);
      console.log(`  you  : ${result.answer || '(no answer)'}`);
      console.log(`  truth: ${truth[result.id]}`);
      const verdict = await rl.question('  correct? [y/n]: ');
      result.correct = verdict.trim().toLowerCase().startsWith('y') ? 'y' : 'n';
    }

    const sessionScoped = results.filter((r) => SESSION_ITEMS.some((i) => i.id === r.id));
    let verdict = 'PASS';
    if (sessionScoped.some((r) => r.correct === 'n')) verdict = 'FAIL(wrong)';
    else if (tSession >= TARGET_SECONDS) verdict = 'FAIL(time)';

    console.log(`\nComputed verdict: ${verdict}`);
    console.log('Override it if the run was FAIL(unanswerable), FAIL(discipline) or VOID.');
    const override = (await rl.question('Override (blank = keep computed): ')).trim();
    const notes = (
      await rl.question('Notes — what was slow, what misled, what was missing: ')
    ).trim();

    appendFileSync(
      LOG_PATH,
      renderBlock({
        label,
        sessionId,
        results,
        truth,
        tSession,
        verdict: override || verdict,
        notes,
      }),
    );
    console.log(`\nAppended to ${LOG_PATH}`);
    console.log('The log is the result. Sign §3 only when every trial is in.\n');
  } finally {
    rl.close();
  }
}

function renderBlock({ label, sessionId, results, truth, tSession, verdict, notes }) {
  const rows = results
    .map(
      (r) =>
        `| ${r.id} | ${r.seconds.toFixed(1)} | ${r.answer || '(none)'} | ${truth[r.id]} | ${r.correct} |`,
    )
    .join('\n');
  return [
    '',
    `### Trial ${label} — ${new Date().toISOString()} — session ${sessionId}`,
    '',
    '| Item | Seconds | Answer given | Ground truth | Correct |',
    '| --- | --- | --- | --- | --- |',
    rows,
    '',
    `**T_session = ${tSession.toFixed(1)} s** (Q1 + Q2 + Q3s; target < ${TARGET_SECONDS} s) → **${verdict}**`,
    '',
    `Notes: ${notes || '—'}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
const labelIndex = rest.indexOf('--label');
const label = labelIndex >= 0 ? (rest[labelIndex + 1] ?? '?') : '?';
const sessionId = rest.find((arg) => !arg.startsWith('--') && arg !== label);

// Only the message, never the Error: a stack trace from `fetch` or from the log
// write carries filesystem paths, and a failed connection is not interesting
// enough to justify printing them.
/** @param {() => Promise<void>} action */
async function guard(action) {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error('Is the server up? `pnpm --filter @agenthropic/server dev`');
    process.exit(1);
  }
}

if (mode === 'select') {
  await guard(select);
} else if (mode === 'run' && sessionId !== undefined) {
  await guard(() => run(sessionId, label));
} else {
  console.log('usage:');
  console.log('  node scripts/time-to-understand.mjs select');
  console.log('  node scripts/time-to-understand.mjs run <sessionId> --label S1');
  console.log('\nSee docs/measurement/time-to-understand-protocol.md before running either.');
  process.exit(1);
}
