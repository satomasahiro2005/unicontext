import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { AdminProvider } from './components/AppContext';
import { ToastProvider } from './components/Toast';
import { router } from './router';
import { applyTheme, readTheme } from './theme';
import './styles.css';

applyTheme(readTheme());

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <AdminProvider>
        <RouterProvider router={router} />
      </AdminProvider>
    </ToastProvider>
  </StrictMode>,
);
