import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { useUi } from './store/ui.js';
import './styles/global.css';

const container = document.getElementById('root');

// Apply the saved/system theme before React paints to avoid a dark flash and
// make the theme toggle deterministic on every route.
useUi.getState().applyTheme();

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
