/**
 * /queue — the work queue on its own page: every chat's list, the unassigned pile, and what
 * finished. The view lives in queue-view.ts and draws no chrome, so a panel can host it too.
 */
import './themes.css'
import { mountQueue } from './queue-view.ts'

mountQueue(document.getElementById('pg') as HTMLElement)
