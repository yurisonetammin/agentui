import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserApp } from './BrowserApp'
import '../src/styles.css'
import './browser.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserApp />
  </StrictMode>,
)
