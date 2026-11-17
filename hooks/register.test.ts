import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clean, digest, SETTLE_MS } from './register'

const TITLE = 'feat(SessionTitle): auto-name sessions by convention'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'

type Opts = { history?: { role: string; text: string }[]; drop?: string; failRenames?: number }

/**
 * The engine beneath the mod: prompts enter the transcript after `history`
 * (rows from before a resume) or are dropped by a settings hook beneath, and
 * `/rename` is recorded. Rows the person didn't type are framed in tags, as
 * the engine frames notifications and command lines.
 */
const engine = (on: On, opts: Opts = {}) => {
  on('command.register', () => ({ value: {} }) as never)
  const rows = (opts.history ?? []).map(r => ({ ...r, toolUses: [] }))
  on('prompt.submit', (_$, e) => {
    if (opts.drop) return { drop: opts.drop }
    const framed = e.command
      ? `<command-name>/${e.command.name}</command-name>`
      : e.isMeta || e.origin.kind !== 'composer'
        ? `<${e.origin.kind}>${e.text}</${e.origin.kind}>`
        : e.text
    rows.push({ role: 'user', text: framed, toolUses: [] })
    return { text: e.text }
  })
  let unreadable = false
  on('session.messages', () => {
    if (unreadable) throw new Error('transcript unreadable')
    return { value: rows } as never
  })
  /** Makes the transcript read fail from now on. */
  const breakMessages = () => {
    unreadable = true
  }
  const renames: string[] = []
  let refusals = opts.failRenames ?? 0
  on('command.run', { command: 'rename' }, (_$, e) => {
    if (refusals-- > 0) throw new Error('refused while a Stop stands')
    renames.push(e.args)
    return { text: 'renamed' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on)
  /** Claude's closing message for the running turn, ending with a desktop `wrap_up` (an `ask` opens its question box). */
  const say = (wrapUp?: { recap: string; ask?: string }) =>
    rows.push({
      role: 'assistant',
      text: 'Done.',
      toolUses: wrapUp ? [{ tool_use_id: `t${rows.length}`, tool: WRAP_UP, input: wrapUp, text: 'ok' }] : [],
    } as never)
  /** The tool results the engine records after a call: a `user` row, but not the person's. */
  const toolResult = () =>
    rows.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'ok' }] } as never)
  /** A `user` row with no words and no tool results. */
  const blankRow = () => rows.push({ role: 'user', text: '  ', toolUses: [] } as never)
  return { renames, clock, say, toolResult, breakMessages, blankRow }
}

/** The engine, with a model that answers `reply` and records what it was asked. */
const stub = (on: On, reply: string, opts: Opts = {}) => {
  const prompts: string[] = []
  on('model.complete', (_$, e) => {
    prompts.push(String(e.prompt))
    return { value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  return { prompts, ...engine(on, opts) }
}

type Submit = { kind?: string; isMeta?: true; command?: { name: string; args: string } }

type Clock = { advance: (ms: number) => Promise<unknown> }

let turns = 0
const turnStart = ($: Engine, agentId?: string) => {
  const turnId = `turn-${++turns}`
  return $.turn.start({ text: '', turnId, ...(agentId && { agentId }) } as never).then(() => turnId)
}
const turnEnd = ($: Engine, turnId: string, opts: { agentId?: string; isAborted?: boolean } = {}) =>
  $.turn.complete({
    answer: '',
    durationMs: 1,
    turnId,
    isAborted: opts.isAborted === true,
    reason: opts.isAborted ? 'aborted' : 'answer',
    ...(opts.agentId && { agentId: opts.agentId }),
  } as never)

/** A prompt is in and its turn has started, but the turn hasn't ended. */
const openTurn = async ($: Engine, text = 'carry on', opts: Submit = {}) => {
  const { kind = 'composer', ...rest } = opts
  await $.prompt.submit({ text, origin: { kind }, wait: false, ...rest } as never)
  return turnStart($)
}

/** Submits a prompt and runs its turn to the end, letting any pending /rename go out. */
const submit = async ($: Engine, clock: Clock, text: string, opts: Submit = {}) => {
  await turnEnd($, await openTurn($, text, opts))
  await clock.advance(SETTLE_MS)
}

const shown = async ($: Engine) => (await $.command.run({ command: 'session-title', args: '' } as never)).text

test('clean normalizes sloppy replies and rejects junk', () => {
  expect(clean('`Feat(claudePlugins): Add session title mod.`')).toBe('feat(ClaudePlugins): add session title mod')
  expect(clean('fix (Auth) : handle expired tokens')).toBe('fix(Auth): handle expired tokens')
  expect(clean('Sure! Here is a title')).toBeUndefined()
  expect(clean('docs(Readme): update')).toBeUndefined()
  const long = clean(`chore(DevEnv): ${'word '.repeat(30)}`)
  expect(long!.length <= 72).toBe(true)
})

test('a truncated title never ends on a dangling filler word', () => {
  expect(clean('chore(SessionManagement): investigate prompt submit hook skipping and sec-default bypass')).toBe(
    'chore(SessionManagement): investigate prompt submit hook skipping',
  )
  expect(clean('fix(Billing): retry failed invoice exports when queue backs up for the nightly batch')).toBe(
    'fix(Billing): retry failed invoice exports when queue backs up',
  )
  expect(clean('fix(Auth): handle expired tokens and the rest')).toBe('fix(Auth): handle expired tokens and the rest')
})

const HISTORY = [
  { role: 'user', text: 'make a hook that renames sessions', toolUses: [] },
  { role: 'assistant', text: 'Here is the plan for the hook.', toolUses: [] },
  { role: 'user', text: '<task-notification>bg job done</task-notification>', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [] },
  { role: 'user', text: 'now add a /autoname command too', toolUses: [] },
]

const stubAutoname = (on: On, reply: string, history = HISTORY, opts: Opts = {}) => {
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(String((e as { text: string }).text))
    return { value: undefined } as never
  })
  return { ...stub(on, reply, { ...opts, history }), logs }
}

const autoname = ($: Engine, args = '') => $.command.run({ command: 'autoname', args } as never)

test('no prompt ever titles the session or calls the model', async ($, on) => {
  // A session named at launch (`claude -n`) keeps that name: nothing here sends /rename on its own.
  const { prompts, renames, clock, say } = stub(on, TITLE)
  await submit($, clock, 'make a hook that renames sessions')
  await submit($, clock, 'from remote control', { kind: 'bridge' })
  await submit($, clock, 'from the sdk', { kind: 'sdk' })
  await submit($, clock, 'task finished', { kind: 'task-notification' })
  await submit($, clock, '/session-title', { command: { name: 'session-title', args: '' } })
  const turnId = await openTurn($, 'one more')
  say({ recap: 'Done.', ask: 'Anything else?' })
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS * 20)
  expect(prompts).toHaveLength(0)
  expect(renames).toEqual([])
  expect(await shown($)).toBe('(no title yet)')
})

test('digest keeps the person and Claude, drops injected rows, keeps first + newest when long', () => {
  const d = digest(HISTORY)
  expect(d).toContain('Person: make a hook that renames sessions')
  expect(d).toContain('Claude: Here is the plan for the hook.')
  expect(d).toContain('Person: now add a /autoname command too')
  expect(d).not.toContain('task-notification')
  const long = Array.from({ length: 40 }, (_, i) => ({ role: 'user', text: `prompt number ${i} ${'x'.repeat(200)}` }))
  const cut = digest(long, 1000)
  expect(cut.length <= 1000).toBe(true)
  expect(cut).toContain('prompt number 0 ')
  expect(cut).toContain('prompt number 39 ')
  expect(cut).not.toContain('prompt number 20 ')
})

test('bare /autoname titles from the session history and renames', async ($, on) => {
  const { prompts, renames, logs, clock } = stubAutoname(on, TITLE)
  const r = await autoname($)
  await clock.advance(SETTLE_MS)
  expect(logs).toEqual([])
  expect(r.text).toBe(`Renamed: ${TITLE}`)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Session so far:')
  expect(prompts[0]).toContain('now add a /autoname command too')
  expect(prompts[0]).not.toContain('Hint from the person')
  expect(renames).toEqual([TITLE])
  expect((await $.command.run({ command: 'session-title', args: '' } as never)).text).toBe(TITLE)
})

test('/autoname <hint> adds the hint on top of the history', async ($, on) => {
  const { prompts } = stubAutoname(on, TITLE)
  await autoname($, 'mostly the rename command')
  expect(prompts[0]).toContain('now add a /autoname command too')
  expect(prompts[0]).toContain('Hint from the person: mostly the rename command')
})

test('/autoname with no history and no hint does nothing', async ($, on) => {
  const { prompts, renames, clock } = stubAutoname(on, TITLE, [])
  expect((await autoname($)).text).toBe('Nothing to title yet.')
  await clock.advance(SETTLE_MS)
  expect(prompts).toHaveLength(0)
  expect(renames).toHaveLength(0)
})

test('/autoname with a junk reply says so and does not rename', async ($, on) => {
  const { renames, clock } = stubAutoname(on, 'Sure! Here is a title')
  expect((await autoname($)).text).toContain("Couldn't generate a title")
  await clock.advance(SETTLE_MS)
  expect(renames).toHaveLength(0)
})

test('/autoname during an open turn is sent only once the turn has ended', async ($, on) => {
  const { renames, clock } = stubAutoname(on, TITLE)
  const turnId = await openTurn($)
  expect((await autoname($)).text).toBe(`Renamed: ${TITLE}`)
  // Claude is waiting on a question or plan approval: nothing is queued.
  await clock.advance(SETTLE_MS * 20)
  expect(renames).toEqual([])
  expect(await shown($)).toBe(TITLE)
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS - 1)
  expect(renames).toEqual([])
  await clock.advance(1)
  expect(renames).toEqual([TITLE])
})

test("/autoname waits for the turn's end even if the mod never hears the turn start", async ($, on) => {
  const { renames, clock } = stubAutoname(on, TITLE)
  await $.prompt.submit({ text: 'carry on', origin: { kind: 'composer' }, wait: false } as never)
  await autoname($)
  await clock.advance(SETTLE_MS * 4)
  expect(renames).toEqual([])
  await turnEnd($, 'unheard-turn')
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test("a subagent's turn ending doesn't send it", async ($, on) => {
  const { renames, clock } = stubAutoname(on, TITLE)
  const turnId = await openTurn($)
  await autoname($)
  const sub = await turnStart($, 'agent-1')
  await turnEnd($, sub, { agentId: 'agent-1' })
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([])
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test('a turn that starts before the send has settled holds it until that turn ends', async ($, on) => {
  const { renames, clock } = stubAutoname(on, TITLE)
  await autoname($)
  await clock.advance(SETTLE_MS / 2)
  const next = await turnStart($) // a prompt queued behind the command
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([])
  await turnEnd($, next)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test('an interrupted turn holds the title for the next turn to end', async ($, on) => {
  const { renames, clock } = stubAutoname(on, TITLE)
  const turnId = await openTurn($)
  await autoname($)
  await turnEnd($, turnId, { isAborted: true })
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([])
  await submit($, clock, 'carry on')
  expect(renames).toEqual([TITLE])
})

test('a refused /rename keeps the title for the next turn to end, and sends it once', async ($, on) => {
  const { renames, logs, clock } = stubAutoname(on, TITLE, HISTORY, { failRenames: 1 })
  await autoname($)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([])
  expect(logs).toHaveLength(1)
  await submit($, clock, 'carry on')
  expect(renames).toEqual([TITLE])
  await submit($, clock, 'and more')
  expect(renames).toEqual([TITLE])
})

test('a /rename by hand while the title waits wins', async ($, on) => {
  const { renames, clock } = stubAutoname(on, TITLE)
  const turnId = await openTurn($)
  await autoname($)
  await $.command.run({ command: 'rename', args: 'my own name' } as never)
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual(['my own name'])
})

test('a /rename by hand that lands while the send is under way wins, and the title is not put back', async ($, on) => {
  const { renames, clock } = stubAutoname(on, TITLE)
  // The person renames at the moment the timer clears `pending`, between its
  // read and its send.
  let raced = false
  on('state.set', async (_$, e, next) => {
    const { value, previous } = e as unknown as { value?: { pending?: string }; previous?: { pending?: string } }
    if (!raced && previous?.pending === TITLE && value?.pending === undefined) {
      raced = true
      void $.command.run({ command: 'rename', args: 'my own name' } as never)
    }
    return next(e)
  })
  await autoname($)
  await clock.advance(SETTLE_MS)
  await clock.advance(SETTLE_MS)
  expect(raced).toBe(true)
  expect(renames).toEqual(['my own name'])
  await submit($, clock, 'carry on')
  expect(renames).toEqual(['my own name'])
})

/** An org whose allowlist (or provider) keeps Haiku out: `haiku` fails as `mode` says, any other model answers. */
const stubManaged = (on: On, mode: 'refused' | 'api-error' | 'rate-limited', sessionModel = 'claude-opus-5-5') => {
  const models: string[] = []
  on('model.complete', (_$, e) => {
    const { model } = e as { model: string }
    models.push(model)
    if (model === 'haiku') {
      if (mode === 'refused') throw new Error('model haiku is not in availableModels')
      const status = mode === 'api-error' ? 403 : 429
      const error = mode === 'api-error' ? 'invalid_request' : 'rate_limit'
      return { value: { isAnswered: false, reason: 'api-error', status, error, usage: { input_tokens: 0, output_tokens: 0 } } } as never
    }
    return { value: { isAnswered: true, text: TITLE, usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  on('session.model', () => ({ value: sessionModel }) as never)
  return { models, ...engine(on, { history: HISTORY }) }
}

const autonameSettled = async ($: Engine, clock: Clock) => {
  const r = await autoname($)
  await clock.advance(SETTLE_MS)
  return r
}

test('a managed allowlist that blocks haiku falls back to the session model', async ($, on) => {
  const { models, renames, clock } = stubManaged(on, 'refused')
  await autonameSettled($, clock)
  expect(renames).toEqual([TITLE])
  expect(models).toEqual(['haiku', 'claude-opus-5-5'])
})

test('a provider that 4xxs on haiku falls back to the session model', async ($, on) => {
  const { models, renames, clock } = stubManaged(on, 'api-error')
  await autonameSettled($, clock)
  expect(renames).toEqual([TITLE])
  expect(models).toEqual(['haiku', 'claude-opus-5-5'])
})

test('a transient haiku error does not spend a call on the session model', async ($, on) => {
  const { models, renames, clock } = stubManaged(on, 'rate-limited')
  expect((await autonameSettled($, clock)).text).toContain("Couldn't generate a title")
  expect(renames).toEqual([])
  expect(models).toEqual(['haiku'])
})

test('no second call when the session model is haiku itself', async ($, on) => {
  const { models, renames, clock } = stubManaged(on, 'refused', 'haiku')
  await autonameSettled($, clock)
  expect(renames).toEqual([])
  expect(models).toEqual(['haiku'])
})

/** /autoname's /rename was refused, so its title waits for a turn's end. */
const stubPending = async ($: Engine, on: On) => {
  const s = stubAutoname(on, TITLE, HISTORY, { failRenames: 1 })
  await autoname($)
  await s.clock.advance(SETTLE_MS)
  expect(s.renames).toEqual([])
  return s
}

test('a pending title is held while a turn ends on a question, until a turn ends without one', async ($, on) => {
  const { renames, clock, say } = await stubPending($, on)
  const turnId = await openTurn($)
  say({ recap: 'Built it, not committed.', ask: 'Commit this?' })
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS * 20)
  // The question box is open after the turn: a /rename row would close it.
  expect(renames).toEqual([])
  expect(await shown($)).toBe(TITLE)
  const next = await openTurn($, 'yes')
  say({ recap: 'Committed.' })
  await turnEnd($, next)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test('a wrap-up with only a recap does not hold a pending title', async ($, on) => {
  const { renames, clock, say } = await stubPending($, on)
  const turnId = await openTurn($)
  say({ recap: 'Answered the question.' })
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test("a question from an earlier turn doesn't hold a later turn's send", async ($, on) => {
  const { renames, clock, say } = await stubPending($, on)
  say({ recap: 'Old.', ask: 'Old question?' })
  const next = await openTurn($)
  say({ recap: 'Done.' })
  await turnEnd($, next)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test('/autoname right after a turn that ended on a question still renames', async ($, on) => {
  const { renames, clock, say } = stubAutoname(on, TITLE)
  const turnId = await openTurn($, 'and one more thing')
  say({ recap: 'Did it.', ask: 'Ship it?' })
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([])
  expect((await autoname($)).text).toBe(`Renamed: ${TITLE}`)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test('a question before the closing text and its tool result still holds a pending title', async ($, on) => {
  const { renames, clock, say, toolResult } = await stubPending($, on)
  const turnId = await openTurn($)
  say({ recap: 'Built it.', ask: 'Commit this?' })
  toolResult()
  say()
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS * 4)
  expect(renames).toEqual([])
})

test('a blank user row after the question does not count as its answer', async ($, on) => {
  const { renames, clock, say, blankRow } = await stubPending($, on)
  const turnId = await openTurn($)
  say({ recap: 'Built it.', ask: 'Commit this?' })
  blankRow()
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS * 4)
  expect(renames).toEqual([])
})

test('an unreadable transcript holds a pending title rather than risk closing a question', async ($, on) => {
  const { renames, clock, breakMessages } = await stubPending($, on)
  const turnId = await openTurn($)
  breakMessages()
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS * 4)
  expect(renames).toEqual([])
  expect(await shown($)).toBe(TITLE)
})
