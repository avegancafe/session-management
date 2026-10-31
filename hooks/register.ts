import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TitleState } from '../types'

const COMMAND = 'session-title'
const AUTONAME = 'autoname'
const MAX_LEN = 72
const HISTORY_LEN = 6000

const PLUGIN = 'session-management' // this plugin's name, as the engine stamps `e.origin`
const state = atom({ plugin: 'session-management', key: 'sessionTitle' } as const, { done: false } as TitleState)

/** A trailing word a truncated title shouldn't end on. */
const DANGLING_RE = /\s+(and|or|but|the|a|an|to|of|for|with|in|on)$/i

export const TITLE_RE =/^(fix|chore|feat)\([A-Z][A-Za-z0-9]*\): [a-z0-9].*\S$/

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
  if (title.length > MAX_LEN) {
    // Cut at a word boundary, then drop filler the cut left dangling ("… skipping and").
    title = title.slice(0, title.lastIndexOf(' ', MAX_LEN))
    while (DANGLING_RE.test(title)) title = title.replace(DANGLING_RE, '')
  }
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

/** Prompts typed by a person (composer, Remote Control, or `-p` / SDK); not wakeups or injected messages. */
const isFromPerson = (kind: string) => kind === 'composer' || kind === 'bridge' || kind === 'sdk'

/**
 * How long a turn's end must stand before `/rename` is sent: a prompt queued
 * behind that turn starts the next one within it, and the send waits again.
 */
export const SETTLE_MS = 500

// The title is applied with `/rename` through `$.command.run`, which puts it
// in the session's input queue. Queued while a turn is under way, it lands on
// whatever that turn waits on — a question or plan-approval prompt — and
// closes it. So a title waits in `pending` and is sent only while no main-loop
// turn is open: when it's ready, if the session is idle, else when the turn
// ends. An idle session runs the command at once, so it is never left in the
// queue for a prompt that opens later. Reset by each load of the module.
let turnOpen = false
let starts = 0 // main-loop turns begun; a change means a turn began after the end
let ends = 0 // main-loop turns ended
let renames = 0 // /rename runs by hand (not this mod's own)

/** Sends the pending title with `/rename` once the session has stood idle for SETTLE_MS. */
const sendWhenIdle = ($: EngineInterface) => {
  if (turnOpen) return
  const seen = starts
  const busy = () => turnOpen || starts !== seen
  // A hook can't run a command itself (it would wait on the turn the hook
  // holds), so the send runs from a timer, after the calling hook returns.
  $.clock.after(SETTLE_MS, async () => {
    const { pending: title } = await read($, state)
    if (!title || busy()) return
    await update($, state, x => ({ ...x, pending: undefined }))
    if (busy()) return void (await update($, state, x => ({ ...x, pending: x.pending ?? title })))
    const before = renames
    $.command.run({ command: 'rename', args: title }).catch(async (err: unknown) => {
      $.ui.log(`${COMMAND}: rename failed: ${err instanceof Error ? err.message : String(err)}`)
      // Kept for the next turn's end, unless someone renamed it meanwhile.
      if (renames === before) await update($, state, x => ({ ...x, pending: x.pending ?? title }))
    })
  })
}

export const register: Register = on => {
  turnOpen = false
  starts = 0
  ends = 0
  renames = 0

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      turnOpen = true
      starts += 1
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    turnOpen = false
    ends += 1
    // After an interrupt the engine refuses plugin commands until the person
    // acts again; the title waits for the next turn's end.
    if (!e.isAborted) sendWhenIdle($)
    return result
  })

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
    await update($, state, x => ({ ...x, title, pending: title, done: true }))
    sendWhenIdle($)
    return { text: `Renamed: ${title}` }
  })

  // A session the person names by hand is theirs: the first-prompt title
  // never overwrites it, even one still waiting for the turn to end.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    if (e.origin?.kind === 'plugin' && e.origin.name === PLUGIN) return next(e)
    renames += 1
    await update($, state, x => ({ ...x, pending: undefined, done: true }))
    return next(e)
  })

  // Titles the session once, from the first message the person sends, and
  // never touches it again. This is `prompt.submit`, not the classic
  // UserPromptSubmit: on a managed machine the built-in sec-default plugin
  // sends classic events past every user-installed plugin's hooks.
  on('prompt.submit', async ($, e, next) => {
    const ended = ends
    const result = await next(e)
    if (result.drop !== undefined || e.command || e.isMeta || !isFromPerson(e.origin.kind)) return result
    // The prompt entered and its turn started; held open even if this mod
    // never hears that turn's start, until it hears the end.
    if (ends === ended) turnOpen = true

    const s = await read($, state)
    if (s.done) return result

    const text = e.text.trim()
    if (!text || !isPersonText(text)) return result

    // Mark done first, so a slow or failed call never retries on a later prompt.
    await update($, state, x => ({ ...x, done: true }))
    // A resumed session already has its name: the person spoke before this prompt.
    const earlier = (await $.session.messages()).filter(
      m => m.role === 'user' && m.text.trim() !== text && isPersonText(m.text.trim()),
    )
    if (earlier.length > 0) return result

    // Titled from a timer, off the turn's critical path: the prompt has
    // already entered, and the hook returns without waiting on the model.
    // The title is sent once the session is idle (see sendWhenIdle).
    const handled = renames
    $.clock.after(0, async () => {
      const title = await generate($, `Request:\n${clip(text, 1500)}`).catch(() => undefined)
      if (!title || renames !== handled) return
      await update($, state, x => ({ ...x, title, pending: title }))
      sendWhenIdle($)
    })
    return result
  })
}
