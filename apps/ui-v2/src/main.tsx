// The Bob theme names Nunito and DM Mono but Astryx never loads fonts; bundle the weights it uses (self-hosted).
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import { installStaleBuildReload } from './app/stale-build';
import { UiObservabilityBoundary } from './lib/observability/ui-observability-boundary';

// Before the first render, so a lazy page that fails during it is already covered.
installStaleBuildReload();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiObservabilityBoundary><App /></UiObservabilityBoundary>
  </StrictMode>,
);
