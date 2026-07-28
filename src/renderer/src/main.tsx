import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/**
 * 드롭 영역 밖에 파일을 놓으면 창이 그 파일로 이동해 버린다.
 * 앱 전체에서 기본 동작을 막고, 실제 처리는 드롭 영역에서만 한다.
 */
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => e.preventDefault())
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
