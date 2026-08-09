/**
 * App shell (WP-U5): header (brand, connection chip, lock), sidebar nav for
 * the four v1.0 views (ux0-design SS1), and the routed view mount. Persistent
 * chrome carries the uncertainty legend - the honesty vocabulary is never
 * hidden behind a tooltip.
 */
import { useEffect, useState } from 'react';
import { checkHealth } from './api';
import { useHashRoute, viewHash, VIEW_IDS } from './router';
import {
  createSseClient,
  SERVER_EVENT_TYPES,
  type SseClient,
  type SseConnectionState,
} from './sse';
import {
  AGENT_STATUSES,
  NULL_STATUS_META,
  STATUS_META,
  UNRECOGNISED_STATUS_LABEL,
  UNRECOGNISED_STATUS_SYMBOL,
} from './views/status';
import { VIEWS } from './views/index';

/**
 * The legend is generated from the status vocabulary itself, so every symbol
 * the app can paint - including `unrecorded` and the `unrecognised` fallback
 * for a status this build does not know - is explained. A symbol that could
 * appear but is missing here would be uncertainty conveyed by glyph alone.
 */
const LEGEND_STATUSES = [
  ...AGENT_STATUSES.map((status) => `${STATUS_META[status].symbol} ${STATUS_META[status].label}`),
  `${NULL_STATUS_META.symbol} ${NULL_STATUS_META.label}`,
  `${UNRECOGNISED_STATUS_SYMBOL} ${UNRECOGNISED_STATUS_LABEL}`,
].join(' ');

type HealthState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly schemaVersion: number }
  | { readonly kind: 'unreachable'; readonly message: string };

export interface ShellProps {
  readonly token: string;
  /** Explicit user action: clear the token and return to the entry screen. */
  readonly onLock: () => void;
  /** The server answered 401 for the stored token: clear it and bounce back. */
  readonly onAuthRejected: () => void;
}

interface Chip {
  readonly label: string;
  readonly className: string;
  readonly title?: string;
}

function chipFor(health: HealthState, stream: SseConnectionState): Chip {
  if (health.kind === 'checking') {
    return { label: 'checking…', className: 'chip chip-wait' };
  }
  if (health.kind === 'unreachable') {
    return { label: 'server unreachable', className: 'chip chip-error', title: health.message };
  }
  switch (stream) {
    case 'connecting':
      return { label: 'connecting…', className: 'chip chip-wait' };
    case 'open':
      return { label: '● live', className: 'chip chip-ok' };
    case 'reconnecting':
      return { label: '○ reconnecting', className: 'chip chip-warn' };
    case 'closed':
      return { label: 'stream closed', className: 'chip chip-error' };
  }
}

export function Shell({ token, onLock, onAuthRejected }: ShellProps) {
  const view = useHashRoute();
  const [health, setHealth] = useState<HealthState>({ kind: 'checking' });
  const [stream, setStream] = useState<SseConnectionState>('connecting');
  const [sse, setSse] = useState<SseClient | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void checkHealth(token, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'ok') {
        setHealth({ kind: 'ok', schemaVersion: result.schemaVersion });
      } else if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else {
        setHealth({ kind: 'unreachable', message: result.message });
      }
    });
    return () => controller.abort();
  }, [token, onAuthRejected]);

  useEffect(() => {
    const client = createSseClient(token, { knownEventTypes: SERVER_EVENT_TYPES });
    setSse(client);
    const unsubscribe = client.onStateChange(setStream);
    return () => {
      unsubscribe();
      client.close();
      setSse(null);
    };
  }, [token]);

  const chip = chipFor(health, stream);
  const active = VIEWS[view];

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">agenthropic</span>
        <span className={chip.className} data-testid="connection-chip" title={chip.title}>
          {chip.label}
        </span>
        {health.kind === 'ok' && (
          <span className="muted schema">schema v{health.schemaVersion}</span>
        )}
        <button type="button" className="lock" onClick={onLock}>
          Lock
        </button>
      </header>
      <div className="shell-body">
        <nav className="sidebar" aria-label="views">
          {VIEW_IDS.map((id) => (
            <a
              key={id}
              href={viewHash(id)}
              className={id === view ? 'nav-link nav-active' : 'nav-link'}
              aria-current={id === view ? 'page' : undefined}
            >
              {VIEWS[id].navLabel}
            </a>
          ))}
          <p className="legend" aria-label="uncertainty legend">
            {LEGEND_STATUSES}
            <br />— observed ┄ inferred ~ unpriced
          </p>
        </nav>
        <main className="view">
          <h1>{active.title}</h1>
          {sse !== null && (
            <active.Component token={token} sse={sse} onAuthRejected={onAuthRejected} />
          )}
        </main>
      </div>
    </div>
  );
}
