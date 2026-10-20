import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clean, digest } from './register'

const TITLE = 'feat(SessionTitle): auto-name sessions by convention'

type Opts = { history?: { role: string; text: string }[]; drop?: string }

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
  on('command.run', { command: 'rename' }, (_$, e) => {
    renames.push(e.args)
    return { text: 'renamed' }
  })
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

/** Submits a prompt, then lets the mod's timers (title, then /rename) run. */
const submit = async ($: Engine, clock: { advance: (ms: number) => Promise<unknown> }, text: string, opts: Submit = {}) => {
  const { kind = 'composer', ...rest } = opts
  const r = await $.prompt.submit({ text, origin: { kind }, wait: false, ...rest } as never)
  await clock.advance(1)
  await clock.advance(1)
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
  await clock.advance(1)
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
  await clock.advance(1)
  expect(prompts).toHaveLength(0)
  expect(renames).toHaveLength(0)
})

test('/autoname with a junk reply says so and does not rename', async ($, on) => {
  const { renames, clock } = stubAutoname(on, 'Sure! Here is a title')
  expect((await autoname($)).text).toContain("Couldn't generate a title")
  await clock.advance(1)
  expect(renames).toHaveLength(0)
})

test('after /autoname the first-prompt path never fires', async ($, on) => {
  const { prompts, renames, clock } = stubAutoname(on, TITLE)
  await autoname($)
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
