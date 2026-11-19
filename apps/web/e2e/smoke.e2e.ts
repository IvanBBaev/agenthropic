/**
 * QA-7 smoke (docs/analysis/role-reviews-2026-10-29/05-qa.md): the real
 * server on the synthetic fixture corpus, the built SPA, a real browser.
 *
 * jsdom tests prove the components; the P0 proofs prove the server. Neither
 * proves that the shipped bundle boots under the server's CSP, signs in, routes
 * and draws the numbers it was handed. This one test does, end to end:
 *
 * - every route of the router renders a known session, a dollar figure or a
 *   DAG edge (the four views plus the session detail route `#/sessions/<id>`,
 *   which is the fifth screen a user reaches);
 * - one SSE update arrives over the wire AND changes the page without a
 *   reload: a new session is written to the corpus mid-test, an observing
 *   EventSource opened in the page receives its `session-ingested` frame, and
 *   the Live board - refreshed only by the app's own stream - grows a card;
 * - the console stays clean (no CSP violation, no uncaught error).
 *
 * Figures are fixture facts at the 1 USD/Mtok synthetic price seeded by
 * serve-fixtures.ts: `depth-2-sync` writes 1,675 tokens, i.e. $0.001675.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { getFixture } from '@agenthropic/test-fixtures';
import { E2E_SLUG, corpusRoot, requireEnv } from './env';

/** The known session: the `depth-2-sync` fixture's main transcript stem. */
function knownSessionId(): string {
  const main = getFixture('depth-2-sync').files.find((f) => !f.relativePath.includes('/'));
  if (main === undefined) throw new Error('depth-2-sync ships no main transcript');
  return main.relativePath.slice(0, -'.jsonl'.length);
}

const KNOWN_SESSION = knownSessionId();
const KNOWN_SHORT = `${KNOWN_SESSION.slice(0, 8)}…`;
const KNOWN_COST = '$0.0017';

/** A brand-new synthetic session, written while the page is open. */
function writeFreshSession(sessionId: string): void {
  const now = new Date().toISOString();
  const lines = [
    {
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/home/synthetic/project',
      sessionId,
      version: '2.0.0',
      type: 'user',
      message: { role: 'user', content: 'Synthetic QA-7 prompt: say hello.' },
      uuid: randomUUID(),
      timestamp: now,
    },
    {
      parentUuid: null,
      isSidechain: false,
      sessionId,
      type: 'assistant',
      message: {
        id: `msg_synth_qa7_${sessionId.slice(0, 8)}`,
        type: 'message',
        role: 'assistant',
        model: 'synthetic-model-a',
        content: [{ type: 'text', text: 'Synthetic QA-7 reply: hello.' }],
        // 50,000 tokens at 1 USD/Mtok: $0.05.
        usage: {
          input_tokens: 20_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 30_000,
        },
      },
      requestId: `req_synth_qa7_${sessionId.slice(0, 8)}`,
      uuid: randomUUID(),
      timestamp: now,
    },
  ];
  const dir = join(corpusRoot(), E2E_SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Dashboard token').fill(requireEnv('E2E_TOKEN'));
  await page.getByLabel('Dashboard token').press('Enter');
  await expect(page.getByTestId('connection-chip')).toContainText('live');
}

async function openRoute(page: Page, route: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/${route}`);
}

test('five routes render fixture facts and one SSE update reaches the page', async ({ page }) => {
  const consoleProblems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));

  await signIn(page);

  // 1. Live: the known session's card with its dollar figure.
  await openRoute(page, 'live');
  const board = page.getByRole('region', { name: 'live status board' });
  await expect(board).toContainText(KNOWN_SHORT);
  await expect(board).toContainText(KNOWN_COST);

  // 2. Sessions: the known session in the list, with its dollar figure.
  await openRoute(page, 'sessions');
  const list = page.getByRole('list', { name: 'session list' });
  await expect(list).toContainText(KNOWN_SHORT);
  await expect(list).toContainText(KNOWN_COST);

  // 3. Session detail: the known session's agent tree draws its edges
  //    (depth-2-sync: main -> child -> grandchild).
  await openRoute(page, `sessions/${KNOWN_SESSION}`);
  const tree = page.getByRole('img', { name: `agent tree for session ${KNOWN_SESSION}` });
  await expect(tree.locator('line')).toHaveCount(2);

  // 4. DAG: edges are drawn, exactly as many as the summary announces.
  await openRoute(page, 'dag');
  const dag = page.getByRole('img', { name: 'global orchestration dag' });
  const summary = page.getByRole('region', { name: 'global dag' }).getByText(/\d+ edges\./);
  await expect(summary).toBeVisible();
  const announced = Number(/(\d+) edges\./.exec(await summary.innerText())?.[1]);
  expect(announced).toBeGreaterThan(0);
  await expect(dag.locator('line')).toHaveCount(announced);

  // 5. Cost: an all-time dollar figure in the summary.
  await openRoute(page, 'cost');
  const cost = page.getByRole('region', { name: 'cost summary' }).first();
  await expect(cost).toContainText(/Total cost/i);
  await expect(cost).toContainText(/\$\d+\.\d{2}/);

  // SSE: back on Live, write a new session and watch it arrive without a reload.
  await openRoute(page, 'live');
  await expect(board).toContainText(KNOWN_SHORT);
  const freshSession = randomUUID();
  const frame = page.evaluate(
    ({ token, sessionId }) =>
      new Promise<string>((resolve, reject) => {
        const source = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
        const timer = window.setTimeout(() => {
          source.close();
          reject(new Error('no session-ingested frame for the fresh session'));
        }, 90_000);
        source.addEventListener('session-ingested', (event) => {
          const data = JSON.parse((event as MessageEvent<string>).data) as { sessionId?: unknown };
          if (data.sessionId === sessionId) {
            window.clearTimeout(timer);
            source.close();
            resolve(data.sessionId);
          }
        });
        source.addEventListener('open', () => {
          document.body.dataset.e2eStream = 'open';
        });
      }),
    { token: requireEnv('E2E_TOKEN'), sessionId: freshSession },
  );
  // Write only once the observing stream is open, so the frame cannot be missed.
  await expect(page.locator('body[data-e2e-stream="open"]')).toHaveCount(1);
  const navigations: string[] = [];
  page.on('framenavigated', (navigated) => {
    if (navigated === page.mainFrame()) navigations.push(navigated.url());
  });
  writeFreshSession(freshSession);

  expect(await frame).toBe(freshSession);
  await expect(board).toContainText(`${freshSession.slice(0, 8)}…`);
  await expect(board).toContainText('$0.05');
  expect(navigations).toEqual([]);

  expect(consoleProblems).toEqual([]);
});
