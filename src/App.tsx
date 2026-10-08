import Curriculum from './Curriculum'
import { AudioLines } from 'lucide-react'

function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Saywell home">
          <span className="brand-mark" aria-hidden="true"><AudioLines size={22} /></span>
          <span>saywell<span className="brand-period">.</span></span>
        </a>
        <div className="topbar-meta">
          <span className="availability-dot" />
          <span>YOUR ENGLISH, OUT LOUD</span>
        </div>
      </header>
      <main id="top" className="lesson-page">
        <Curriculum />
      </main>
      <footer className="page-footer">
        <span>SAYWELL <span className="brand-period">/</span> SPEAKING PRACTICE</span>
        <span>ฝึกพูดภาษาอังกฤษทีละคำ</span>
      </footer>
    </div>
  )
}

export default App
