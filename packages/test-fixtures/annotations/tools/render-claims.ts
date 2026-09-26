/**
 * CLI entry of the LABEL-ME claim renderer.
 *
 *   pnpm --filter @agenthropic/test-fixtures render-claims -- <template-id>
 *
 * Every line of logic (template reading, the mirrored parser join, page and
 * index rendering, the `substrate unavailable` exit) lives in
 * `src/annotations/render-claims.ts`, where it is covered at 100% without
 * spawning a subprocess; this file only wires argv, stdout/stderr and the exit
 * code. Output goes under `annotations/.render/<id>/`, which is git-ignored
 * because the pages quote real transcript lines.
 */
import { fileURLToPath } from 'node:url';
import { runRenderClaims } from '../../src/annotations/render-claims.js';

process.exitCode = runRenderClaims(process.argv.slice(2), {
  packageDir: fileURLToPath(new URL('../../', import.meta.url)),
  repoRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
});
