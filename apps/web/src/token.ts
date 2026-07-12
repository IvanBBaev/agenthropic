/**
 * Dashboard token handling. The token lives ONLY in sessionStorage (and React
 * state) - never in localStorage, never in a cookie, and it must never be
 * logged or rendered.
 */
const TOKEN_KEY = 'agenthropic.token';

export function readToken(): string | null {
  const value = sessionStorage.getItem(TOKEN_KEY);
  return value !== null && value.length > 0 ? value : null;
}

export function storeToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
