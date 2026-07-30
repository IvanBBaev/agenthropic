/**
 * App root (WP-U5): the token gate. No token in memory -> the entry screen
 * (which validates against /api/health before storing anything); a validated
 * token -> the shell. A 401 from inside the shell clears the token and
 * bounces back here with a notice.
 */
import { useCallback, useState } from 'react';
import { Shell } from './Shell';
import { TokenScreen } from './TokenScreen';
import { clearToken, readToken, storeToken } from './token';

export default function App() {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [notice, setNotice] = useState<string | null>(null);

  const handleAuthRejected = useCallback(() => {
    clearToken();
    setToken(null);
    setNotice('The server rejected the stored token. Enter it again.');
  }, []);

  const handleLock = useCallback(() => {
    clearToken();
    setToken(null);
    setNotice(null);
  }, []);

  if (token === null) {
    return (
      <TokenScreen
        {...(notice !== null ? { notice } : {})}
        onSuccess={(value) => {
          storeToken(value);
          setNotice(null);
          setToken(value);
        }}
      />
    );
  }

  return <Shell token={token} onLock={handleLock} onAuthRejected={handleAuthRejected} />;
}
