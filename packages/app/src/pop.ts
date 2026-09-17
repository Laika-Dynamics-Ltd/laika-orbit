/**
 * The page a pop-out window loads (pop.html?part=…): one part of the app filling a window.
 * The main window keeps notifications and the map; this is only the part itself.
 */
import './control.css'
import { mountControl } from './control.ts'
import { POP_IN_ICON, type PopPart, popOut } from './popout.ts'
import { createSessions } from './sessions.ts'
import { applyTheme } from './themes.ts'

const part = new URLSearchParams(location.search).get('part') as PopPart | null
document.body.dataset.part = part ?? ''

// a theme picked in the main window follows here
addEventListener('storage', (e) => {
  if (e.key === '1brain:theme') applyTheme(e.newValue ?? 'midnight')
})

if (part === 'claude') {
  document.title = 'Claude · Laika Orbit'
  createSessions({ popped: true }).open()
} else if (part === 'control') {
  document.title = 'Agent control · Laika Orbit'
  const root = document.createElement('div')
  document.body.appendChild(root)
  const view = mountControl(root, {
    extra: `<button class="c-btn ghost c-popin" type="button" title="Put back in the main window" aria-label="Put back in the main window">${POP_IN_ICON}</button>`,
  })
  root.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.c-popin')) popOut('control', false)
  })
  view.start()
} else {
  document.body.textContent = `Nothing called “${part}” can pop out.`
}
