/**
 * Token entry screen (WP-U5). The SPA renders nothing else until possession
 * of the DASHBOARD_TOKEN is proven against /api/health. The token value is
 * validated BEFORE it is stored: a 401 keeps the user here with an inline
 * error and nothing persisted.
 */
import { useState, type FormEvent } from 'react';
import { checkHealth } from './api';

export interface TokenScreenProps {
  /** Called with the validated token; the caller stores it and mounts the shell. */
  readonly onSuccess: (token: string) => void;
  /** Optional message shown when the shell bounced the user back here. */
  readonly notice?: string;
}

export function TokenScreen({ onSuccess, notice }: TokenScreenProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = value.trim();
    if (token.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const result = await checkHealth(token);
    setBusy(false);
    if (result.kind === 'ok') {
      onSuccess(token);
      return;
    }
    setError(
      result.kind === 'unauthorized'
        ? 'Invalid token: the server rejected it.'
        : `Server unreachable: ${result.message}`,
    );
  }

  return (
    <form
      className="token-form"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      aria-label="token entry"
    >
      <h1>agenthropic</h1>
      <p>Enter the dashboard token to connect.</p>
      {notice !== undefined && (
        <p className="status-warn" role="status">
          {notice}
        </p>
      )}
      <label htmlFor="token-input">Dashboard token</label>
      <input
        id="token-input"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      {error !== null && (
        <p className="status-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}
