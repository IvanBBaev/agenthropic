import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { clearToken, readToken, storeToken } from './token';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; status: string; schemaVersion: string }
  | { kind: 'error'; message: string };

type StreamState = 'connecting' | 'open' | 'error';

function TokenForm({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = value.trim();
    if (token.length === 0) return;
    onSubmit(token);
  }

  return (
    <form className="token-form" onSubmit={handleSubmit} aria-label="token entry">
      <h1>agenthropic</h1>
      <p>Enter the dashboard token to connect.</p>
      <label htmlFor="token-input">Dashboard token</label>
      <input
        id="token-input"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit">Connect</button>
    </form>
  );
}

function Dashboard({ token, onAuthError }: { token: string; onAuthError: () => void }) {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const [stream, setStream] = useState<StreamState>('connecting');
  const [heartbeats, setHeartbeats] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function loadHealth() {
      try {
        const response = await fetch('/api/health', {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (response.status === 401) {
          onAuthError();
          return;
        }
        if (!response.ok) {
          setHealth({ kind: 'error', message: `health check failed (HTTP ${response.status})` });
          return;
        }
        const body: unknown = await response.json();
        const record = body as Record<string, unknown>;
        setHealth({
          kind: 'ok',
          status: typeof record['status'] === 'string' ? record['status'] : 'unknown',
          schemaVersion:
            typeof record['schemaVersion'] === 'string'
              ? record['schemaVersion']
              : typeof record['version'] === 'string'
                ? record['version']
                : 'unknown',
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setHealth({
          kind: 'error',
          message: error instanceof Error ? error.message : 'health check failed',
        });
      }
    }

    void loadHealth();
    return () => controller.abort();
  }, [token, onAuthError]);

  useEffect(() => {
    const source = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
    const onHeartbeat = () => setHeartbeats((count) => count + 1);

    source.onopen = () => setStream('open');
    source.onerror = () => setStream('error');
    source.addEventListener('heartbeat', onHeartbeat);
    source.onmessage = onHeartbeat;

    return () => source.close();
  }, [token]);

  return (
    <main className="dashboard">
      <h1>agenthropic</h1>
      <section aria-label="health">
        <h2>Server health</h2>
        {health.kind === 'loading' && <p className="muted">Checking…</p>}
        {health.kind === 'ok' && (
          <p>
            <span className="status-ok">{health.status}</span>
            {' — schema '}
            <code>{health.schemaVersion}</code>
          </p>
        )}
        {health.kind === 'error' && <p className="status-error">{health.message}</p>}
      </section>
      <section aria-label="stream">
        <h2>Event stream</h2>
        <p>
          Connection: <span className={`stream-${stream}`}>{stream}</span>
        </p>
        <p>
          Heartbeats: <span data-testid="heartbeat-count">{heartbeats}</span>
        </p>
      </section>
      <button
        type="button"
        className="disconnect"
        onClick={() => {
          onAuthError();
        }}
      >
        Disconnect
      </button>
    </main>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => readToken());

  const handleAuthError = useCallback(() => {
    clearToken();
    setToken(null);
  }, []);

  if (token === null) {
    return (
      <TokenForm
        onSubmit={(value) => {
          storeToken(value);
          setToken(value);
        }}
      />
    );
  }

  return <Dashboard token={token} onAuthError={handleAuthError} />;
}
