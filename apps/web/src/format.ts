/**
 * Pure display formatters shared by the dashboard views (WP-U6..U9). All are
 * deterministic (fixed locale, injected clock) so the visual vocabulary is
 * unit-testable. Dollar figures always come from server-side ground truth;
 * these helpers only shape digits, they never estimate.
 */

/** Token counts: compact above 10k (`56.8k`, `1.2M`), grouped digits below. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toLocaleString('en-US');
}

/**
 * USD amounts: cents precision normally, four decimals for sub-cent amounts
 * so a real-but-tiny cost never rounds to a misleading `$0.00`. An exact zero
 * renders as `$0.00` - genuinely nothing priced, not a rounding artifact.
 */
export function formatUsd(costUsd: number): string {
  if (costUsd === 0) return '$0.00';
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Relative recency for an ISO timestamp against an injected clock. `null` in,
 * or an unparseable value, -> `null` (the caller renders the honest "no
 * timestamp" copy instead of inventing one). Small negative skew reads as
 * `just now`.
 */
export function formatRelativeTime(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return null;
  const seconds = Math.floor((nowMs - timestamp) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Session ids are UUID-ish; eight leading chars identify one on screen. */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}
