/** Standalone /control page; the same view also lives in the brain map's drawer. */
import './themes.css'
import './control.css'
import { mountControl } from './control.ts'

const view = mountControl(document.getElementById('ctl') as HTMLElement, {
  notify: true,
  extra: `<a class="c-btn ghost" href="/">Brain map →</a><time class="c-clock"></time>`,
  onCounts: (c) => {
    const waiting = c.needs + c.blocked
    document.title = waiting ? `(${waiting}) Agent control` : 'Agent control'
  },
})
view.start()
const tick = () => {
  const t = document.querySelector('.c-clock')
  if (t) t.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
tick()
setInterval(tick, 15_000)
