/**
 * Parser input substrate — the already-read file contents the pure
 * reconstruction parser consumes (parser-spec section 2).
 *
 * The parser does NO filesystem or network I/O: reading `~/.claude/projects`
 * off disk is a separate adapter (apps/server, WP-IN5) and is out of scope
 * here. This shape is intentionally structurally identical to a
 * `@agenthropic/test-fixtures` `Fixture` (which additionally carries `name`
 * and `description`), so a `Fixture` is assignable to `SessionSubstrate` and
 * tests can call `parseSession(getFixture(name))` directly.
 */

/** One on-disk file, expressed as its already-split JSONL lines. */
export interface SubstrateFile {
  /** Path relative to the session directory, e.g. `subagents/agent-3fa9c2d1.jsonl`. */
  readonly relativePath: string;
  /** File content, one JSON document per entry (a `.meta.json` file is a single line). */
  readonly lines: readonly string[];
}

/** All files of a single Claude Code session, as read from disk by the adapter. */
export interface SessionSubstrate {
  readonly files: readonly SubstrateFile[];
}
