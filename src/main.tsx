import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import App from './App'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { applySettings, loadSettings } from './lib/settings'
import './styles/index.css'
import './styles/glass.css'
import { installGlassPointer } from './lib/glassPointer'

// Apply the same central-default + saved-override settings path before React mounts.
applySettings(loadSettings())
installGlassPointer()

// IMPORTANT (file://): the production bundle is a CLASSIC script injected into <head>, so it runs
// BEFORE <div id="root"> is parsed. Wait for the DOM before mounting, or createRoot would get null.
function mount() {
  const el = document.getElementById('root')
  if (!el) return
  // reducedMotion="user" makes every motion/react animation honor the OS "reduce motion" setting
  // (the CSS media query only tames CSS animations, not framer-motion's JS-driven ones).
  createRoot(el).render(
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <ErrorBoundary label="the board">
          <App />
        </ErrorBoundary>
      </MotionConfig>
    </StrictMode>,
  )
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
