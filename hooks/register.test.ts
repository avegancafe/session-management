import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clean, digest } from './register'

const TITLE = 'feat(SessionTitle): auto-name sessions by convention'

const stub = (on: On, reply: string) => {
  const prompts: string[] = []
  on('model.complete', (_$, e) => {
    prompts.push(String(e.prompt))
    return { value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  on('command.register', () => ({ value: {} }) as never)
  on('classic.UserPromptSubmit', () => ({}))
  return prompts
}

const submit = ($: Engine, prompt: string, opts: { session_title?: string; source?: string } = {}) =>
  $.classic.UserPromptSubmit({ prompt, source: 'user', ...opts } as never)

test('clean normalizes sloppy replies and rejects junk', () => {
  expect(clean('`Feat(claudePlugins): Add session title mod.`')).toBe('feat(ClaudePlugins): add session title mod')
  expect(clean('fix (Auth) : handle expired tokens')).toBe('fix(Auth): handle expired tokens')
  expect(clean('Sure! Here is a title')).toBeUndefined()
  expect(clean('docs(Readme): update')).toBeUndefined()
  const long = clean(`chore(DevEnv): ${'word '.repeat(30)}`)
  expect(long!.length <= 72).toBe(true)
})

test('first prompt is titled from that prompt alone', async ($, on) => {
  const prompts = stub(on, TITLE)
  const r = await submit($, 'make a hook that renames sessions')
  expect(r.sessionTitle).toBe(TITLE)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('make a hook that renames sessions')
})

test('later prompts never retitle or call the model', async ($, on) => {
  const prompts = stub(on, TITLE)
  await submit($, 'first')
  const r2 = await submit($, 'second', { session_title: TITLE })
  const r3 = await submit($, 'third')
  expect(r2.sessionTitle).toBeUndefined()
  expect(r3.sessionTitle).toBeUndefined()
  expect(prompts).toHaveLength(1)
})

test('injected prompts are skipped and do not use up the first prompt', async ($, on) => {
  const prompts = stub(on, TITLE)
  expect((await submit($, 'task finished', { source: 'system' })).sessionTitle).toBeUndefined()
  expect((await submit($, 'wake up', { source: 'loop_wakeup' })).sessionTitle).toBeUndefined()
  expect(prompts).toHaveLength(0)
  expect((await submit($, 'make a hook that renames sessions')).sessionTitle).toBe(TITLE)
})

test('an already-named session is left alone', async ($, on) => {
  const prompts = stub(on, TITLE)
  const r = await submit($, 'continue', { session_title: 'my own name' })
  expect(r.sessionTitle).toBeUndefined()
  await submit($, 'more')
  expect(prompts).toHaveLength(0)
})

test('a junk model reply gives no title and is not retried', async ($, on) => {
  const prompts = stub(on, 'Sure! Here is a title')
  expect((await submit($, 'first')).sessionTitle).toBeUndefined()
  expect((await submit($, 'second')).sessionTitle).toBeUndefined()
  expect(prompts).toHaveLength(1)
})

const HISTORY = [
  { role: 'user', text: 'make a hook that renames sessions', toolUses: [] },
  { role: 'assistant', text: 'Here is the plan for the hook.', toolUses: [] },
  { role: 'user', text: '<task-notification>bg job done</task-notification>', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [] },
  { role: 'user', text: 'now add a /autoname command too', toolUses: [] },
]

const stubAutoname = (on: On, reply: string, history: unknown[] = HISTORY) => {
  const prompts = stub(on, reply)
  const renames: string[] = []
  on('session.messages', () => ({ value: history }) as never)
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(String((e as { text: string }).text))
    return { value: undefined } as never
  })
  const clock = mock.clock(on)
  on('command.run', { command: 'rename' }, (_$, e) => {
    renames.push(e.args)
    return { text: 'renamed' }
  })
  return { prompts, renames, logs, clock }
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
  const { prompts } = stubAutoname(on, TITLE)
  await autoname($)
  expect((await submit($, 'make a hook that renames sessions')).sessionTitle).toBeUndefined()
  expect(prompts).toHaveLength(1)
})

test('a slash command as the first prompt is not titled from', async ($, on) => {
  const prompts = stub(on, TITLE)
  expect((await submit($, '/autoname')).sessionTitle).toBeUndefined()
  expect(prompts).toHaveLength(0)
})
