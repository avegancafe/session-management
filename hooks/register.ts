import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TitleState } from '../types'

const COMMAND = 'session-title'
const AUTONAME = 'autoname'
const MAX_LEN = 72
const HISTORY_LEN = 6000

const state = atom({ plugin: 'session-management', key: 'sessionTitle' } as const, { done: false } as TitleState)

export const TITLE_RE = /^(fix|chore|feat)\([A-Z][A-Za-z0-9]*\): [a-z0-9].*\S$/

const RULES = `You name coding sessions. Reply with ONE line and nothing else, in exactly this form:

<type>(<Scope>): <description>

- <type> is one of: feat (new capability), fix (something broken), chore (maintenance, config, docs, refactors, investigations, tooling).
- <Scope> is ONE PascalCase word naming the high-level area: a product area, system or repo (e.g. Auth, Billing, ClaudePlugins, Beads, CI, DevEnv). No spaces, no dots, no slashes.
- <description> is an imperative, lowercase phrase that says what the session is doing ("add retry to export uploads", not "added" or "adding"). No trailing period. Keep the whole line under ${MAX_LEN} characters.`

/** Normalizes a model reply into a valid title, or undefined if it can't. */
export const clean = (raw: string): string | undefined => {
  const line = raw
    .split('\n')
    .map(l => l.trim().replace(/^[`"'*]+|[`"'*.]+$/g, ''))
    .find(l => l.length > 0)
  if (!line) return undefined
  const m = /^(fix|chore|feat)\s*\(\s*([A-Za-z0-9]+)\s*\)\s*:\s*(.+)$/i.exec(line)
  const [, type = '', scope = '', desc = ''] = m ?? []
  if (!type || !scope || !desc) return undefined
  let title = `${type.toLowerCase()}(${scope.charAt(0).toUpperCase()}${scope.slice(1)}): ${desc.charAt(0).toLowerCase()}${desc.slice(1)}`
  if (title.length > MAX_LEN) title = title.slice(0, title.lastIndexOf(' ', MAX_LEN))
  return TITLE_RE.test(title) ? title : undefined
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** API errors that mean "this model isn't yours to call", not "try later". */
const MODEL_REFUSED = new Set([400, 401, 403, 404])

/**
 * Asks Haiku for a title under RULES; `body` is what it titles from.
 *
 * A managed org can keep Haiku out of reach: its `availableModels` allowlist
 * makes the engine refuse the call, or its provider/gateway answers 4xx for a
 * model it doesn't serve. Either way the title comes from the session's own
 * model instead, which the org has necessarily allowed.
 */
const generate = async ($: EngineInterface, body: string) => {
  const prompt = `${body}\n\nTitle:`
  const ask = { system: RULES, prompt, maxTokens: 60, effort: 'low' } as const
  const tried = new Set<string>()
  for (const next of [async () => 'haiku', () => $.session.model()]) {
    const model = await next().catch(() => undefined)
    if (!model || tried.has(model)) continue
    tried.add(model)
    const r = await $.model.complete({ ...ask, model }).catch(() => undefined)
    if (r?.isAnswered) return clean(r.text)
    if (r && !(r.reason === 'api-error' && r.status !== null && MODEL_REFUSED.has(r.status))) return undefined
  }
  return undefined
}

/** Injected rows (`<task-notification>`, …) and slash commands aren't the person's words. */
const isPersonText = (text: string) => !text.startsWith('<') && !text.startsWith('/')

/**
 * The conversation so far as `Person:` / `Claude:` lines, tool calls dropped.
 * Over `max` chars it keeps the first line (what the session set out to do)
 * and the newest tail (where it is now).
 */
export const digest = (messages: readonly { role: string; text: string }[], max = HISTORY_LEN): string => {
  const lines = messages.flatMap(m => {
    const text = m.text.trim()
    if (!text) return []
    if (m.role === 'user') return isPersonText(text) ? [`Person: ${clip(text, 1500)}`] : []
    return [`Claude: ${clip(text, 600)}`]
  })
  const all = lines.join('\n\n')
  if (all.length <= max || lines.length < 2) return clip(all, max)
  const [first = '', ...rest] = lines
  const tail: string[] = []
  let room = max - first.length - 10
  for (const line of rest.reverse()) {
    if (line.length + 2 > room) break
    tail.unshift(line)
    room -= line.length + 2
  }
  return [first, '…', ...tail].join('\n\n')
}

/** Prompts typed by a person (interactive, or `-p` / SDK); not wakeups or injected messages. */
const isFromPerson = (source: string | undefined) => source === undefined || source === 'user' || source === 'sdk'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show the auto session title' })
    await $.command.register({
      name: AUTONAME,
      description: 'Re-title this session from its history, by the session-title convention',
      argumentHint: '[optional hint]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const s = await read($, state)
    return { text: s.title ?? '(no title yet)' }
  })

  // Re-titles the session on demand from everything said so far, under the
  // same RULES; anything after `/autoname` is a hint on top of the history.
  on('command.run', { command: AUTONAME }, async ($, e) => {
    const history = digest(await $.session.messages())
    const hint = e.args.trim()
    if (!history && !hint) return { text: 'Nothing to title yet.' }
    const body = [history && `Session so far:\n${history}`, hint && `Hint from the person: ${clip(hint, 300)}`]
      .filter(Boolean)
      .join('\n\n')
    const title = await generate($, body).catch(() => undefined)
    if (!title) return { text: "Couldn't generate a title. Try `/autoname <hint>`." }
    await update($, state, x => ({ ...x, title, done: true }))
    // A command hook can't run another command (it would wait on the turn
    // this hook holds), so /rename runs from a timer once this one returns.
    $.clock.after(0, () => {
      $.command.run({ command: 'rename', args: title }).catch((err: unknown) => {
        $.ui.log(`autoname: rename failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    })
    return { text: `Renamed: ${title}` }
  })

  // Titles the session once, from the first message the person sends, and
  // never touches it again.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (result.block || !isFromPerson(e.source)) return result

    const s = await read($, state)
    if (s.done) return result
    if (e.session_title) {
      // Already named (resumed, renamed by hand, or started with a name).
      await update($, state, x => ({ ...x, done: true }))
      return result
    }

    const text = e.prompt.trim()
    if (!text || !isPersonText(text)) return result

    // Mark done first, so a slow or failed call never retries on a later prompt.
    await update($, state, x => ({ ...x, done: true }))
    const title = await generate($, `Request:\n${clip(text, 1500)}`).catch(() => undefined)
    if (!title) return result
    await update($, state, x => ({ ...x, title }))
    return { ...result, sessionTitle: title }
  })
}
