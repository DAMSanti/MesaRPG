import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { applyQualityOverride } from './deviceProfile'

// Read once, before anything renders: the profile is cached on first use
// and every canvas asks for it as it mounts.
applyQualityOverride(window.location.search)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
