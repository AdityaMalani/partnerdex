import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import PortalApp from './PortalApp';
// The dashboard's stylesheet, then the handful of rules the portal adds. Same
// design system, same tokens: an affiliate should recognise the product, and a
// second palette would be a second thing to keep in step.
import '../styles.css';
import './portal.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <PortalApp />
  </StrictMode>,
);
