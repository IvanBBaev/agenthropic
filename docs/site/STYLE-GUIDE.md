# Docs style guide (DOC-P3)

Conventions every docs page follows so parallel authors converge. Applies to all pages
under `docs/site/`.

## Voice & structure
- **English only.** Audience: senior engineers self-hosting Claude Code observability.
- **Front-load the answer.** The first paragraph states what the page covers and the key
  takeaway; detail follows. No throat-clearing.
- **Detailed and precise.** Use headings, tables, code/SQL blocks, and ASCII/mermaid
  diagrams where they clarify. Each page is a thorough reference, not a stub.
- **Evidence, not marketing.** Every non-obvious claim traces to a source (a
  `DESIGN.md §`, an analysis file, or a due-diligence file). Never invent facts, numbers,
  APIs, or file paths. If something is undecided or not yet built, say so and link the
  roadmap/decision.

## Hard invariants (never contradict these in prose or samples)
- The app binds **`127.0.0.1` loopback only** — never `0.0.0.0`.
- It **never** spawns `claude`/subprocesses driven by request input (the hoangsonww
  `/api/run` RCE is the anti-pattern).
- The auth token is **mandatory** (`timingSafeEqual`), not opt-in / not a no-op-when-unset.
- **No SSRF** — never dial a URL taken from an event payload.
- Remote access is via **SSH port-forward or Tailscale tunnel only** — never a reverse
  proxy to the open port.
- Tokens are **ground truth read from `~/.claude/projects/*.jsonl`**, never inferred.

## As-built amendments (standing convention since 2026-07)

Most of this corpus was authored **before any application code existed** (the design-target
era, up to 2026-07-11). Implementation has since diverged from parts of the design. The
corpus is **amended, never rewritten** — the design record is evidence of how the decisions
were reached, and deleting it would hide the reasoning. Every page therefore follows the
same three-part convention:

1. **One amendment blockquote near the top**, immediately after the page intro, opening
   with exactly:

   ```
   > **Update — 2026-07 (as built).**
   ```

   It states plainly what is true now, in specifics verified against the repository —
   real file paths, real commands, real numbers — and ends by saying that the prose below
   is kept as the design record.
2. **Reframe, don't delete.** Prose that asserted something now untrue moves into
   past/design tense ("the design basis assumed…", "as first sketched…"), keeping the
   original claim legible. Never silently swap a design claim for an as-built one.
3. **Short inline resolution notes** where a specific sentence, table row, or diagram
   resolved differently — `*(As built: … )*` — or a nested `> **As built:** …` blockquote
   for a whole section. A `(planned)` / `(leaning — unconfirmed)` tag stays where it was
   and gets a note saying what it resolved to.

Constraints on every amendment:

- **Never break a link or an anchor.** Do not rename files, delete sections, or change
  headings other pages link to — 129 relative links point outward across this corpus.
- **Prefer "not built" over vagueness.** Name what is blocked and on whom; mark an
  estimate as an estimate; never leave a reader able to conclude a feature exists when it
  does not.
- **Carry the standing caveats forward** wherever they are load-bearing: the Phase-0 spike
  numbers stay **PROVISIONAL** until ratified against a hand-labeled corpus, the "<30s to
  understand a session" v1.0 usability claim is **unmeasured**, and kill checkpoints KC-0
  and KC-1 both **passed unmet** — work continues by explicit owner override, not because
  the gates were satisfied.
- **Don't overclaim the proofs.** Three P0 correctness proofs are green and merge-blocking
  (Σ tokens vs JSONL · byte-identical double replay · DAG rebuilt from JSONL alone). Cite
  those precisely; do not stretch them into a general correctness guarantee.

## Mechanics
- **Placeholder secrets** in samples: `DASHBOARD_TOKEN=<token>`, `--host <tailscale-host>`.
  Never a real value.
- **Terminology:** `subagent` (one word), `Claude Code`, `DAG`, `SQLite WAL`,
  `orchestration_edges`, `token_usage`, `events_raw`, ground-truth tokens.
- **Cross-links:** relative Markdown links to sibling pages by slug — e.g. a page under
  `security/` links the data model as `../architecture/data-model.md`; a page under
  `architecture/` links a sibling as `data-model.md`.
- **No generator-specific frontmatter** in content pages — added at assembly.
- **ADRs** use [`contributing/decisions/_adr-template.md`](contributing/decisions/_adr-template.md).

## Definition of Done (per page)
See [`../DOCS-PLAN.md`](../DOCS-PLAN.md) §6.
