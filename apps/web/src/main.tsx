import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { DashboardProvider } from './context/DashboardContext';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <DashboardProvider><App /></DashboardProvider>
    </BrowserRouter>
  </StrictMode>,
);
