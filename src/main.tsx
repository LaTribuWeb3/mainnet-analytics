import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import TradesPage from './TradesPage'
import CompetitionAnalysis from './CompetitionAnalysis'
import SingleOrderExplorer from './SingleOrderExplorer'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/trades" element={<TradesPage />} />
        <Route path="/competition" element={<CompetitionAnalysis />} />
        <Route path="/order" element={<SingleOrderExplorer />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
