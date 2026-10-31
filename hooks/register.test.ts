import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clean, digest, SETTLE_MS } from './register'

const TITLE = 'feat(SessionTitle): auto-name sessions by convention'

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
  on('session.messages', () => ({ value: rows }) as never)
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
  return { renames, clock }
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

/** Lets the mod's title timer run, mid-turn. */
const settleTitle = async (clock: Clock) => {
  await clock.advance(1)
  await clock.advance(1)
}

/** Submits a prompt and runs its turn to the end, letting the mod's timers (title, then /rename) run. */
const submit = async ($: Engine, clock: Clock, text: string, opts: Submit = {}) => {
  const { kind = 'composer', ...rest } = opts
  const r = await $.prompt.submit({ text, origin: { kind }, wait: false, ...rest } as never)
  const turnId = await turnStart($)
  await settleTitle(clock)
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS)
  return r
}

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

test('first prompt is titled from that prompt alone, by /rename', async ($, on) => {
  const { prompts, renames, clock } = stub(on, TITLE)
  const r = await submit($, clock, 'make a hook that renames sessions')
  expect(r).toEqual({ text: 'make a hook that renames sessions' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('make a hook that renames sessions')
  expect(renames).toEqual([TITLE])
  expect((await $.command.run({ command: 'session-title', args: '' } as never)).text).toBe(TITLE)
})

test('later prompts never retitle or call the model', async ($, on) => {
  const { prompts, renames, clock } = stub(on, TITLE)
  await submit($, clock, 'first')
  await submit($, clock, 'second')
  await submit($, clock, 'third')
  expect(prompts).toHaveLength(1)
  expect(renames).toEqual([TITLE])
})

test('injected prompts are skipped and do not use up the first prompt', async ($, on) => {
  const { prompts, renames, clock } = stub(on, TITLE)
  await submit($, clock, 'task finished', { kind: 'task-notification' })
  await submit($, clock, 'wake up', { kind: 'scheduled-trigger' })
  await submit($, clock, 'hidden', { isMeta: true })
  expect(prompts).toHaveLength(0)
  await submit($, clock, 'make a hook that renames sessions')
  expect(renames).toEqual([TITLE])
})

test('a resumed session is left alone', async ($, on) => {
  const { prompts, renames, clock } = stub(on, TITLE, {
    history: [
      { role: 'user', text: 'fix the flaky export test' },
      { role: 'assistant', text: 'Fixed.' },
    ],
  })
  await submit($, clock, 'continue')
  await submit($, clock, 'more')
  expect(prompts).toHaveLength(0)
  expect(renames).toHaveLength(0)
})

test('a session renamed by hand is left alone', async ($, on) => {
  const { prompts, renames, clock } = stub(on, TITLE)
  await $.command.run({ command: 'rename', args: 'my own name' } as never)
  await submit($, clock, 'make a hook that renames sessions')
  expect(prompts).toHaveLength(0)
  expect(renames).toEqual(['my own name'])
})

test('a dropped prompt is not titled from', async ($, on) => {
  const { prompts, renames, clock } = stub(on, TITLE, { drop: 'blocked by policy' })
  expect(await submit($, clock, 'make a hook that renames sessions')).toEqual({ drop: 'blocked by policy' })
  await submit($, clock, 'try again')
  expect(prompts).toHaveLength(0)
  expect(renames).toHaveLength(0)
})

test('a junk model reply gives no title and is not retried', async ($, on) => {
  const { prompts, renames, clock } = stub(on, 'Sure! Here is a title')
  await submit($, clock, 'first')
  await submit($, clock, 'second')
  expect(prompts).toHaveLength(1)
  expect(renames).toHaveLength(0)
})

/** The first prompt is in, its turn has started and its title is ready, but the turn hasn't ended. */
const openFirstTurn = async ($: Engine, clock: Clock, text = 'make a hook that renames sessions') => {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
  const turnId = await turnStart($)
  await settleTitle(clock)
  return turnId
}

const shown = async ($: Engine) => (await $.command.run({ command: 'session-title', args: '' } as never)).text

test('the title is never sent while the turn is open, and is sent once it has ended', async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
  const turnId = await openFirstTurn($, clock)
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

test("the title waits for the turn's end even if the mod never hears the turn start", async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
  await $.prompt.submit({ text: 'make a hook that renames sessions', origin: { kind: 'composer' }, wait: false } as never)
  await settleTitle(clock)
  await clock.advance(SETTLE_MS * 4)
  expect(renames).toEqual([])
  await turnEnd($, 'unheard-turn')
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test("a subagent's turn ending doesn't send it", async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
  const turnId = await openFirstTurn($, clock)
  const sub = await turnStart($, 'agent-1')
  await turnEnd($, sub, { agentId: 'agent-1' })
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([])
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test('a turn that starts before the end has settled holds the title until it ends too', async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
  await turnEnd($, await openFirstTurn($, clock))
  await clock.advance(SETTLE_MS / 2)
  const next = await turnStart($) // a prompt queued behind the first turn
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([])
  await turnEnd($, next)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test('an interrupted turn holds the title for the next turn to end', async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
  await turnEnd($, await openFirstTurn($, clock), { isAborted: true })
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([])
  await submit($, clock, 'carry on')
  expect(renames).toEqual([TITLE])
})

test('a title ready after a quick turn has ended is sent while the session is idle', async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
  await $.prompt.submit({ text: 'what is 2+2', origin: { kind: 'composer' }, wait: false } as never)
  await turnEnd($, await turnStart($))
  await settleTitle(clock)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual([TITLE])
})

test('a refused /rename keeps the title for the next turn to end', async ($, on) => {
  const { renames, clock } = stub(on, TITLE, { failRenames: 1 })
  await submit($, clock, 'make a hook that renames sessions')
  expect(renames).toEqual([])
  await submit($, clock, 'carry on')
  expect(renames).toEqual([TITLE])
  await submit($, clock, 'and more')
  expect(renames).toEqual([TITLE])
})

test('a /rename by hand while the title waits wins', async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
  const turnId = await openFirstTurn($, clock)
  await $.command.run({ command: 'rename', args: 'my own name' } as never)
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual(['my own name'])
})

test('a /rename by hand that lands while the send is under way wins, and the title is not put back', async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
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
  await turnEnd($, await openFirstTurn($, clock))
  await clock.advance(SETTLE_MS)
  await clock.advance(SETTLE_MS)
  expect(raced).toBe(true)
  expect(renames).toEqual(['my own name'])
  await submit($, clock, 'carry on')
  expect(renames).toEqual(['my own name'])
})

test('a /rename by hand while the title is still being written wins', async ($, on) => {
  const { renames, clock } = stub(on, TITLE)
  await $.prompt.submit({ text: 'make a hook', origin: { kind: 'composer' }, wait: false } as never)
  const turnId = await turnStart($)
  await $.command.run({ command: 'rename', args: 'my own name' } as never)
  await settleTitle(clock)
  await turnEnd($, turnId)
  await clock.advance(SETTLE_MS)
  expect(renames).toEqual(['my own name'])
  expect(await shown($)).toBe('(no title yet)')
})

const HISTORY = [
  { role: 'user', text: 'make a hook that renames sessions', toolUses: [] },
  { role: 'assistant', text: 'Here is the plan for the hook.', toolUses: [] },
  { role: 'user', text: '<task-notification>bg job done</task-notification>', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [] },
  { role: 'user', text: 'now add a /autoname command too', toolUses: [] },
]

const stubAutoname = (on: On, reply: string, history = HISTORY) => {
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(String((e as { text: string }).text))
    return { value: undefined } as never
  })
  return { ...stub(on, reply, { history }), logs }
}

const autoname = ($: Engine, args = '') => $.command.run({ command: 'autoname', args } as never)

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

test('after /autoname the first-prompt path never fires', async ($, on) => {
  const { prompts, renames, clock } = stubAutoname(on, TITLE)
  await autoname($)
  await clock.advance(SETTLE_MS)
  await submit($, clock, 'make a hook that renames sessions')
  expect(prompts).toHaveLength(1)
  expect(renames).toEqual([TITLE])
})

test('a slash command as the first prompt is not titled from', async ($, on) => {
  const { prompts, clock } = stub(on, TITLE)
  await submit($, clock, '/session-title', { command: { name: 'session-title', args: '' } })
  expect(prompts).toHaveLength(0)
  await submit($, clock, 'make a hook that renames sessions')
  expect(prompts).toHaveLength(1)
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
  return { models, ...engine(on) }
}

test('a managed allowlist that blocks haiku falls back to the session model', async ($, on) => {
  const { models, renames, clock } = stubManaged(on, 'refused')
  await submit($, clock, 'make a hook that renames sessions')
  expect(renames).toEqual([TITLE])
  expect(models).toEqual(['haiku', 'claude-opus-5-5'])
})

test('a provider that 4xxs on haiku falls back to the session model', async ($, on) => {
  const { models, renames, clock } = stubManaged(on, 'api-error')
  await submit($, clock, 'make a hook that renames sessions')
  expect(renames).toEqual([TITLE])
  expect(models).toEqual(['haiku', 'claude-opus-5-5'])
})

test('a transient haiku error does not spend a call on the session model', async ($, on) => {
  const { models, renames, clock } = stubManaged(on, 'rate-limited')
  await submit($, clock, 'make a hook that renames sessions')
  expect(renames).toEqual([])
  expect(models).toEqual(['haiku'])
})

test('no second call when the session model is haiku itself', async ($, on) => {
  const { models, renames, clock } = stubManaged(on, 'refused', 'haiku')
  await submit($, clock, 'make a hook that renames sessions')
  expect(renames).toEqual([])
  expect(models).toEqual(['haiku'])
})
