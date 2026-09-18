/**
 * Secrets a chat needs (a login, an API key), kept in the macOS Keychain and out of the chat.
 *
 * A chat asks for a secret by name with the `secret_request` tool. If the Keychain has it, the
 * tool says how to read it inside a command; if not, the chat shows a password field, you type it
 * once, and it goes straight into the Keychain. The model never sees the value: not in the tool's
 * input, not in its result, not in the transcript. Commands read it at run time with `security`.
 *
 *   Keychain   service "laika-orbit secret", account = the secret's name
 *
 * The value reaches `security` on stdin (its interactive mode), never on a command line, so `ps`
 * cannot show it. Only this Mac: on a Linux node there is no Keychain and the tool is left out.
 */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

export const SERVICE = 'laika-orbit secret'

/** a name is a label, never a value: letters, digits, dot, dash, underscore, up to 64 */
export const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)

export const available = () => process.platform === 'darwin'

const run = (args, input) =>
  new Promise((resolve, reject) => {
    const p = execFile('security', args, { timeout: 15_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim().slice(0, 200))) : resolve(stdout),
    )
    if (input !== undefined) p.stdin.end(input)
  })

/** quoted for `security -i`, which splits its lines like a shell: backslash and quote escaped */
const quote = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`

export async function hasSecret(name, { keychain } = {}) {
  if (!validName(name)) return false
  try {
    // without -w or -g, `security` prints the item's attributes and never its value
    await run(['find-generic-password', '-s', SERVICE, '-a', name, ...(keychain ? [keychain] : [])])
    return true
  } catch {
    return false
  }
}

export async function saveSecret(name, value, { keychain } = {}) {
  if (!validName(name)) throw new Error('Secret names are letters, digits, dot, dash and underscore')
  if (typeof value !== 'string' || !value.length) throw new Error('Nothing to save')
  if (/[\n\r\0]/.test(value)) throw new Error('A secret cannot contain a line break')
  const line = ['add-generic-password', '-U', '-s', quote(SERVICE), '-a', quote(name), '-l', quote(`${SERVICE}: ${name}`), '-w', quote(value), ...(keychain ? [quote(keychain)] : [])]
  // `security -i` exits 0 even when a command in it fails, so check the item is really there
  await run(['-i'], `${line.join(' ')}\n`)
  if (!(await hasSecret(name, { keychain }))) throw new Error('The Keychain did not accept it')
}

/** names only: parsed from the attributes `security` lists, which never include the values */
export async function listSecrets({ keychain } = {}) {
  let out
  try {
    out = await run(['dump-keychain', ...(keychain ? [keychain] : [])])
  } catch {
    return []
  }
  const names = new Set()
  for (const item of out.split(/^keychain: /m)) {
    if (!item.includes(`"svce"<blob>="${SERVICE}"`)) continue
    const m = /"acct"<blob>="([^"]*)"/.exec(item)
    if (m && validName(m[1])) names.add(m[1])
  }
  return [...names].sort()
}

/** the shell snippet a command reads the secret with; `name` is validated, so it is safe quoted */
export const readSnippet = (name) => `"$(security find-generic-password -s '${SERVICE}' -a '${name}' -w)"`

export const usage = (name) =>
  `The secret "${name}" is in the macOS Keychain. You cannot see its value, and must not try to. ` +
  `Use it only inside a command, e.g. PASS=${readSnippet(name)} some-tool --password-stdin <<<"$PASS". ` +
  'Never echo, print, log or cat it, never pass it where the output would show it, and never write it to a file, a commit or a message.'

/**
 * The chat's secrets tools. `ask` shows the password field and resolves with { value } or
 * { behavior: 'deny' }; `tool` is the SDK's, or a stand-in in tests.
 */
export function secretTools({ ask, tool, store = { hasSecret, saveSecret, listSecrets } }) {
  const { z } = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))('zod')
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })
  return [
    tool(
      'secret_request',
      'Get a password, token or other credential without it passing through the chat. If the user has stored it, returns how to use it in a command; ' +
        'otherwise the user is asked to type it into a secure field and it is saved in the macOS Keychain. Use this instead of asking the user to paste a secret, ' +
        'and if they paste one anyway, tell them to rotate it. The value is never returned to you.',
      {
        name: z.string().describe('a short stable name, e.g. "box1-ssh" or "shop-admin"; letters, digits, . _ -'),
        why: z.string().max(300).describe('one line shown to the user: what the secret is for'),
      },
      async ({ name, why }) => {
        if (!validName(name)) return text('Secret names are letters, digits, dot, dash and underscore, up to 64 characters.', true)
        if (await store.hasSecret(name)) return text(usage(name))
        const r = await ask({ name, why: String(why ?? '').slice(0, 300) })
        if (r?.behavior === 'deny' || typeof r?.value !== 'string' || !r.value) {
          return text(`The user did not provide "${name}"${r?.message ? `: ${r.message}` : ''}.`, true)
        }
        try {
          await store.saveSecret(name, r.value)
        } catch (e) {
          return text(`Could not save "${name}" to the Keychain: ${e.message}`, true)
        }
        return text(`Saved. ${usage(name)}`)
      },
    ),
    tool('secret_list', 'List the names (never the values) of the secrets stored for chats in the macOS Keychain.', {}, async () => {
      const names = await store.listSecrets()
      return text(names.length ? names.join('\n') : 'No secrets stored yet.')
    }),
  ]
}

export async function secretsServer(ask) {
  const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')
  return createSdkMcpServer({ name: 'secrets', version: '1.0.0', tools: secretTools({ ask, tool }) })
}
