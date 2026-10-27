import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Toaster } from 'sonner';
import { App } from './App';
import './index.css';
import { rememberCounterFromUrl } from './lib/counter';
import { queryClient } from './lib/queryClient';
import { restoreAppearance } from './lib/theme';

rememberCounterFromUrl();
restoreAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster position="top-center" richColors closeButton toastOptions={{ duration: 4000 }} />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
