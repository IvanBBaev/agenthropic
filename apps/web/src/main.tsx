import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('root element not found');
}

createRoot(container).render(
  <StrictMode>
    {/* The last resort, outside the shell. The per-view boundary in `Shell`
        keeps a crashed view from taking the chrome; this one keeps a crash in
        the chrome itself - the token screen, the router, the header - from
        leaving a blank white page with nothing to read and nothing to click. */}
    <ErrorBoundary
      subject="The dashboard"
      stillWorks="This failed above the navigation, so there is nothing left on the page to click away to."
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
