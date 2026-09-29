import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth.js';
import { ApiRequestError } from './lib/api.js';
import { App } from './App.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * Do not retry client errors. A 401, 403, 404 or 422 will fail exactly the
       * same way three times in a row - retrying just delays the error message
       * the user needs to see by a couple of seconds.
       */
      retry: (failureCount, error) => {
        if (error instanceof ApiRequestError && error.status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
    mutations: {
      // Never auto-retry a write: the server may have applied the first attempt.
      retry: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
