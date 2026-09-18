/**
 * Machines that run Claude sessions and terminals for this app. Each machine runs its own
 * agent-host.mjs; this Mac's is `local`, and other machines are reached through a transport
 * (an SSH tunnel) that ends in a loopback port here, so every host is spoken to the same way:
 * HTTP with that host's token.
 *
 * The browser addresses chats and terminals by id alone. Ids are UUIDs, so they never collide
 * across machines; the router remembers which machine each one lives on, from the lists and
 * from creating them, and asks every machine again when it meets an id it has not seen (after
 * the web server restarts). A machine that is offline drops out of the lists; `local` failing
 * is an error, as it always was.
 *
 *   reach(node)   → { base, token }   where that machine's host answers, starting it if need be
 *   forget(node)                      the last reach failed: check again next time
 *   ids()         → ['local', …]      machines currently configured
 */
export const LOCAL = 'local'

export function createNodeRouter({ reach, forget = () => {}, ids = () => [LOCAL] }) {
  /** chat or terminal id → machine id */
  const owners = new Map()

  const has = (node) => ids().includes(node)

  /** a request to one machine's host; failing to reach it makes the router check it again */
  async function call(node, path, init = {}) {
    const { base, token } = await reach(node)
    try {
      return await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, 'x-agent-token': token } })
    } catch (e) {
      if (e?.name !== 'AbortError') forget(node)
      throw e
    }
  }

  /** every machine's sessions or terms, each tagged with its machine */
  async function list(kind, ms = 10_000) {
    const all = await Promise.all(
      ids().map(async (node) => {
        try {
          const r = await call(node, `/${kind}`, { signal: AbortSignal.timeout(ms) })
          if (!r.ok) throw new Error(`${node} answered ${r.status}`)
          const items = await r.json()
          for (const x of items) owners.set(x.id, node)
          return items.map((x) => ({ ...x, node }))
        } catch (e) {
          if (node === LOCAL) throw e
          return []
        }
      }),
    )
    return all.flat()
  }

  /** the machine a chat or terminal lives on; one never seen is looked for everywhere */
  async function where(id) {
    const known = owners.get(id)
    if (known && has(known)) return known
    if (ids().length > 1) await Promise.all([list('sessions'), list('terms')]).catch(() => {})
    return owners.get(id) ?? LOCAL
  }

  /** CPU, memory and what each machine is running, for choosing where new work goes */
  async function status(ms = 3000) {
    return Promise.all(
      ids().map(async (id) => {
        try {
          const r = await call(id, '/health?machine=1', { signal: AbortSignal.timeout(ms) })
          if (!r.ok) throw new Error(`answered ${r.status}`)
          const h = await r.json()
          return { id, online: true, sessions: h.sessions ?? 0, machine: h.machine ?? null }
        } catch (e) {
          return { id, online: false, error: String(e?.message ?? e).slice(0, 160) }
        }
      }),
    )
  }

  return {
    has,
    call,
    list,
    where,
    status,
    remember: (id, node) => owners.set(id, node),
    drop: (id) => owners.delete(id),
  }
}
