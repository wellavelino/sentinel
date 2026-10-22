import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'sentinel',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const usage = (read: number) => ({
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: 800,
  model: 'test',
})

const typed = (command: string, args: string) =>
  ({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  }) as const

type Said = { logs: string[]; opened: string[]; asks: { model?: string; prompt: string }[]; calls: string[]; tools: string[]; registered: { name: string; isDeferred?: boolean }[] }

/** The engine beneath the mod: turns, model requests that report `usage`, agents, and a model to ask. */
function world(
  on: On,
  reply = '{"highlights": [], "missed": ""}',
  surfaces: readonly ('terminal' | 'desktop')[] = ['terminal'],
): Said & { clock: ReturnType<typeof mock.clock> } {
  const said: Said = { logs: [], opened: [], asks: [], calls: [], tools: [], registered: [] }
  const clock = mock.clock(on, { now: 1000 })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usage(e.agentId === undefined ? 40_000 : 10_000),
    }
  })
  on('tool.call', ($, e) => {
    said.calls.push(String(e.tool))

    if (e.tool === 'TaskList') {
      return {
        result: {
          tasks: [
            { id: '1', subject: 'Reproduce', status: 'completed', blockedBy: [] },
            { id: '2', subject: 'Fix', status: 'pending', blockedBy: ['1'] },
          ],
        },
        text: 'ok',
      }
    }

    return { result: e.tool === 'TaskCreate' ? { task: { id: String(e.subject), subject: e.subject } } : { success: true }, text: 'ok' }
  })
  // The tools the session has: none of the task tools unless a test names them.
  on('tool.list', () => ({ value: said.tools.map(name => ({ name, description: '' })) as never }))
  on('command.run', { command: 'goal' }, () => ({ text: 'Goal set.' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 42_000, window: 200_000, percent: 21 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 34.5 }],
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => {
    said.registered.push({ name: e.name, isDeferred: e.isDeferred })

    return { value: { tool: `mcp__sentinel__${e.name}` } }
  })
  on('session.surfaces', () => ({ value: surfaces }))
  on('agent.list', () => ({
    value: [{ id: 'agent-1', description: 'Review the parser', type: 'general-purpose', status: 'running' }],
  }))
  on('model.complete', ($, e) => {
    said.asks.push({ model: e.model, prompt: e.prompt })

    return { value: { isAnswered: true, text: reply, usage: usage(0) } }
  })
  on('model.fork', ($, e) => {
    said.asks.push({ prompt: e.prompt })

    return { value: { isAnswered: true, text: reply, usage: usage(0) } }
  })
  on('ui.open', ($, e) => {
    said.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', ($, e) => {
    said.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine drew: {e.props.text}</Text>
  })

  return { ...said, clock }
}

// A subagent's tool call, as the engine raises it inside the agent's loop.
const AGENT_CALL = { tool: 'Bash', command: 'ls', agentId: 'agent-1' } as never

const step = { turnId: 'turn-1', index: 0, model: 'test', messageCount: 2 }

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of stream) {
    void chunk
  }
}

describe('the progress band', () => {
  test('stays out of the way until there is a goal, a task or an agent', async ($, on) => {
    world(on)
    await $.turn.start({ text: 'What does this function do?', turnId: 'turn-1' })
    await drain($.turn.step(step))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
    await ui.unmount()
  })

  test('shows the goal, the task bar, the context and the session limit', async ($, on) => {
    world(on)
    await $.turn.start({ text: 'Ship the parser', turnId: 'turn-1' })
    await $.command.run(typed('goal', 'all parser tests pass'))
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Write parser', status: 'completed', activeForm: 'Writing parser' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
        { content: 'Announce', status: 'pending', activeForm: 'Announcing' },
      ],
    })
    await drain($.turn.step(step))

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

      expect(texts).toContain('Goal: all parser tests pass')
      expect(texts.some(text => /1\/4/.test(text))).toBe(true)
      expect(texts).toContain('███')
      expect(texts.some(text => /▸ Writing tests/.test(text))).toBe(true)
      expect(texts.some(text => /21% 42k/.test(text))).toBe(true)
      expect(texts).toContain('35%')
      await ui.unmount()
    }
  })

  test('names the work by the prompt when no goal is set, and follows created tasks', async ($, on) => {
    world(on)
    await $.turn.start({ text: 'Fix the flaky login test', turnId: 'turn-1' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Reproduce', description: 'x', activeForm: 'Reproducing' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Fix', description: 'y' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: 'Reproduce', status: 'completed' })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(texts).toContain('Fix the flaky login test')
    expect(texts.some(text => /1\/2/.test(text))).toBe(true)
    await ui.unmount()
  })

  test('gives each subagent a row: what it does, its context and its share of the use', async ($, on) => {
    world(on)
    await $.turn.start({ text: 'Review the parser', turnId: 'turn-1' })
    await drain($.turn.step(step))
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    await $.tool.call(AGENT_CALL)
    await $.tool.call(AGENT_CALL)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(await texts()).toContain('Review the parser')
    expect(await texts()).toContain('running · 2 tools · Bash')
    expect((await texts()).some(text => /6% 12k/.test(text))).toBe(true)
    expect(await texts()).toContain('64% of use')
    expect(await texts()).toContain('36% of use')

    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-9', agentId: 'agent-1', reason: 'answer' })
    expect(await texts()).toContain('done · 2 tools')

    // The next prompt clears the agents that finished.
    await $.turn.start({ text: 'Next', turnId: 'turn-2' })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
    await ui.unmount()
  })

  test('draws nothing of its own when the band is off', { options: { band: 'off' } }, async ($, on) => {
    world(on)
    await $.command.run(typed('goal', 'ship it'))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
    await ui.unmount()
  })

  test('yields the band to a survey', async ($, on) => {
    world(on)
    await $.command.run(typed('goal', 'ship it'))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
    await ui.unmount()
  })
})

const ANSWER =
  'The migration is applied, but 2 of 14 tests still fail in the billing module, and I did not look into why yet. ' +
  'You need to rotate the API key before Friday, since the old one was printed in the build log during this run.'

const done = { answer: ANSWER, durationMs: 5, isAborted: false, turnId: 'turn-1', reason: 'answer' } as const

const marked = async (ui: { findAll: (query: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Text' })).filter(text => text.props.backgroundColor !== undefined).map(text => text.text)

const message = { plugin: 'sentinel', component: 'AssistantMessage', requestId: 'message-1', props: { text: ANSWER, isFirstOfReply: true } } as const

const PANE = {
  plugin: 'sentinel',
  component: 'Pane',
  requestId: 'sentinel',
  props: { title: 'sentinel', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

describe('the agents panel', () => {
  test('opens for a new subagent and gives it a card: status, time, tools, context, use', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Review the parser', turnId: 'turn-1' })
    await $.command.run(typed('goal', 'all parser tests pass'))
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Write parser', status: 'completed', activeForm: 'Writing parser' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
      ],
    })
    await drain($.turn.step(step))
    expect(said.opened).toEqual([])

    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    expect(said.opened).toEqual(['sentinel'])

    // A second request of the same agent is no news: the panel is not asked for again.
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    expect(said.opened).toEqual(['sentinel'])

    await $.tool.call(AGENT_CALL)
    await said.clock.advance(72_000)
    await $.tool.call(AGENT_CALL)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)

      expect(await texts()).toContain('● 1 running')
      expect(await texts()).toContain('◆ Goal')
      expect(await texts()).toContain('all parser tests pass')
      expect(await texts()).toContain('1/3')
      expect(await texts()).toContain('Write parser')
      expect(await texts()).toContain('Writing tests')
      expect(await texts()).toContain('Main thread')
      expect(await texts()).toContain('21%  42k of 200k')
      expect(await texts()).toContain('5h 35%')
      expect(await texts()).toContain('Review the parser')
      expect(await texts()).toContain('running 1m 12s')
      expect(await texts()).toContain('general-purpose · 2 tools · now: Bash')
      expect(await texts()).toContain('6%  12k')
      await ui.unmount()
    }

    await said.clock.advance(8000)
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-9', agentId: 'agent-1', reason: 'answer' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(texts).toContain('done in 1m 20s')
    expect(texts).toContain('general-purpose · 2 tools')
    expect(await ui.find({ type: 'Text', text: '● 1 running' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the agents board', () => {
  test('opens the panel only when asked, where it is set to manual', { options: { panel: 'manual' } }, async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Review the parser', turnId: 'turn-1' })
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    expect(said.opened).toEqual([])

    expect((await $.command.run(typed('progress', ''))).text).toBe('Panel opened: no tasks · 1 subagent on the board.\n◆ Working on: Review the parser\n↳ Review the parser · running')
    expect(said.opened).toEqual(['sentinel'])
  })

  test('lets go of an agent the engine no longer runs when the next prompt comes', async ($, on) => {
    world(on)
    await $.turn.start({ text: 'Review the parser', turnId: 'turn-1' })
    // An agent the engine's list does not hold: its end was never heard of.
    await drain($.turn.step({ ...step, agentId: 'agent-lost' }))
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    await $.turn.start({ text: '/etc/hosts has a stale entry, fix it', turnId: 'turn-2' })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(texts).toContain('/etc/hosts has a stale entry, fix it')
    expect(texts).toContain('Review the parser')
    expect(texts).not.toContain('agent')
    await ui.unmount()
  })

  test('forgets the tasks and the agents on /progress clear', async ($, on) => {
    world(on)
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    expect((await $.command.run(typed('progress', 'clear'))).text).toBe('The tasks and the subagents are forgotten.')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
    await ui.unmount()
  })
})

const TODOS = Array.from({ length: 12 }, (_, index) => ({
  content: `Step ${index + 1}`,
  status: index < 2 ? 'completed' : index === 2 ? 'in_progress' : 'pending',
  activeForm: `Doing step ${index + 1}`,
}))

describe('the task list in the panel', () => {
  test('lists every task with a bar of its own, and moves the bar of the one in progress', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Ship the parser', turnId: 'turn-1' })
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    await $.command.run(typed('progress', ''))

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)
      const moving = async () => (await texts()).find(text => /^─*━━━─*$/.test(text))

      for (const todo of TODOS) {
        expect(await texts()).toContain(todo.status === 'in_progress' ? todo.activeForm : todo.content)
      }

      expect((await texts()).some(text => /more to do|done before/.test(text))).toBe(false)
      expect((await texts()).filter(text => text === '━━━━━━━━━━').length).toBe(2)
      expect((await texts()).filter(text => text === '──────────').length).toBe(9)

      const before = await moving()
      expect(before?.length).toBe(10)

      await said.clock.advance(250)
      const after = await moving()
      expect(after?.length).toBe(10)
      expect(after).not.toBe(before)
      await ui.unmount()
    }

    // With the panel gone nothing keeps the frames coming: a look asks for one more, and no more
    // than that one comes however long the panel then stays away.
    const glance = async () => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const at = (await ui.findAll({ type: 'Text' })).map(text => text.text).find(text => /^─*━━━─*$/.test(text))?.indexOf('━')
      await ui.unmount()

      return at ?? -1
    }

    await said.clock.advance(1000)
    const first = await glance()
    await said.clock.advance(5000)
    expect(await glance()).toBe(first + 1)
  })

  test('draws no moving bar and counts no frames while nothing is in progress', async ($, on) => {
    const said = world(on)
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.map(todo => ({ ...todo, status: 'pending' })) } as never)
    await $.command.run(typed('progress', ''))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await said.clock.advance(2000)

    expect((await ui.findAll({ type: 'Text' })).some(text => /━━━/.test(text.text))).toBe(false)

    // No frame was counted meanwhile: the first bar to move starts from its first cell.
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toContain('━━━───────')
    await ui.unmount()
  })

  test('lists a subagent’s own tasks in its card, and turns its mark while it runs', async ($, on) => {
    const said = world(on)
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Read the parser', status: 'completed', activeForm: 'Reading the parser' },
        { content: 'Write the report', status: 'in_progress', activeForm: 'Writing the report' },
      ],
      agentId: 'agent-1',
    } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(await texts()).toContain('Read the parser')
    expect(await texts()).toContain('Writing the report')
    expect(await texts()).toContain('⠋')
    // On its card, not on the main list.
    expect((await $.command.run(typed('progress', ''))).text).toMatch(/: no tasks ·[\s\S]*↳ Review the parser · running · 1 of 2 tasks done\n  ✔ Read the parser\n  ▸ Writing the report$/)

    await said.clock.advance(250)
    expect(await texts()).toContain('⠙')
    expect(await texts()).not.toContain('⠋')
    await ui.unmount()
  })

  test('reads the engine’s own task list on /progress, where the session has one', async ($, on) => {
    const said = world(on)
    said.tools.push('TaskList')
    await $.turn.start({ text: 'Fix the flaky login test', turnId: 'turn-1' })

    expect((await $.command.run(typed('progress', ''))).text).toBe(
      'Panel opened: 1 of 2 tasks done · 0 subagents on the board.\n◆ Working on: Fix the flaky login test\n  ✔ Reproduce\n  ○ Fix',
    )
    expect(said.calls).toEqual(['TaskList'])

    // A call of the mod's own is no work of the assistant's: the second reader's count leaves it out.
    await $.turn.complete(done)
    await said.clock.advance(1000)
    expect(said.asks[0]?.prompt).toMatch(/made 0 tool calls itself/)
  })

  test('asks for no task list where the session has no such tool', async ($, on) => {
    const said = world(on)

    expect((await $.command.run(typed('progress', ''))).text).toBe('Panel opened: no tasks and no subagents on the board yet.')
    expect(said.calls).toEqual([])
  })
})

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

describe('the mod’s own task tool', () => {
  test('is offered, in the prompt’s tool list, where the session has no task list tool', async ($, on) => {
    const said = world(on)
    said.tools.push('Bash', 'TaskStop')
    await $.session.start(START)

    expect(said.registered).toEqual([{ name: 'tasks', isDeferred: false }])
  })

  test('is not offered where Claude Code keeps a task list itself', async ($, on) => {
    const said = world(on)
    said.tools.push('Bash', 'TaskCreate')
    await $.session.start(START)

    expect(said.registered).toEqual([])
  })

  test('is not offered when turned off', { options: { tasks: 'off' } }, async ($, on) => {
    const said = world(on)
    await $.session.start(START)

    expect(said.registered).toEqual([])
  })

  test('keeps the list the model sends, shows it, and answers how far the work is', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Ship the parser', turnId: 'turn-1' })
    const ran = await $.tool.call({ tool: 'mcp__sentinel__tasks', todos: TODOS } as never)

    expect(ran.text).toBe('Task list kept: 2 of 12 done, now: Doing step 3.')
    expect(ran.result).toBe('Task list kept: 2 of 12 done, now: Doing step 3.')
    expect(ran.isError).toBeUndefined()
    // Answered by the mod: no tool of the engine's ran.
    expect(said.calls).toEqual([])

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await band.findAll({ type: 'Text' })).some(text => /2\/12/.test(text.text))).toBe(true)
    await band.unmount()

    await $.command.run(typed('progress', ''))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toContain('Doing step 3')
    await ui.unmount()
  })

  test('books a subagent’s list on its own card', async ($, on) => {
    world(on)
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    await $.tool.call({ tool: 'mcp__sentinel__tasks', todos: TODOS.slice(0, 3), agentId: 'agent-1' } as never)

    expect((await $.command.run(typed('progress', ''))).text).toMatch(/↳ Review the parser · running · 2 of 3 tasks done/)
  })

  test('tells the model what to send when the list is missing', async ($, on) => {
    world(on)
    const ran = await $.tool.call({ tool: 'mcp__sentinel__tasks' } as never)

    expect(ran.isError).toBe(true)
    expect(ran.text).toMatch(/todos/)
    expect(ran.result).toBe(ran.text)
  })

  test('answers a permission check for its own tool, and no other, with allow', async ($, on) => {
    world(on)
    on('tool.check', () => ({ decision: 'ask' }))

    expect((await $.tool.check({ tool: 'mcp__sentinel__tasks', input: { todos: [] } } as never)).decision).toBe('allow')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } } as never)).decision).toBe('ask')
  })

  test('leaves a rule that denies its tool standing', async ($, on) => {
    world(on)
    on('tool.check', () => ({ decision: 'deny', reason: 'a rule of the person’s' }))

    expect(await $.tool.check({ tool: 'mcp__sentinel__tasks', input: { todos: [] } } as never)).toMatchObject({ decision: 'deny', reason: 'a rule of the person’s' })
  })

  test('draws a very long list within what one drawing holds, and says what it left out', async ($, on) => {
    world(on)
    const many = Array.from({ length: 200 }, (_, index) => ({
      content: `Step ${index + 1} ${'x'.repeat(300)}`,
      status: index < 100 ? 'completed' : index === 100 ? 'in_progress' : 'pending',
      activeForm: `Doing step ${index + 1}`,
    }))
    await $.tool.call({ tool: 'mcp__sentinel__tasks', todos: many } as never)
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    await $.tool.call({ tool: 'mcp__sentinel__tasks', todos: many, agentId: 'agent-1' } as never)
    await $.command.run(typed('progress', ''))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThan(30_000)
    expect(texts).toContain('Doing step 101')
    expect(texts).toContain('  … 99 done before')
    expect(texts.some(text => /^  … \d+ more to do$/.test(text))).toBe(true)
    await ui.unmount()
  })
})

describe('the second reader', () => {
  test('makes no call when the highlighter is not the reader', { options: { highlight: 'claude' } }, async ($, on) => {
    const said = world(on)
    await $.turn.complete(done)
    await said.clock.advance(1000)

    expect(said.asks).toEqual([])
  })

  test('asks haiku about the reply by default, highlights what it names and says what was left out', async ($, on) => {
    const said = world(on, '{"highlights": ["2 of 14 tests still fail", "rotate the API key before Friday", "not in the reply"], "missed": "The lint step was skipped."}')
    await $.turn.start({ text: 'Apply the migration', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Bash', command: 'make migrate' })
    await $.turn.complete(done)
    expect(said.asks).toEqual([])

    await said.clock.advance(1000)
    expect(said.asks.length).toBe(1)
    expect(said.asks[0]?.model).toBe('haiku')
    expect(said.asks[0]?.prompt).toMatch(/<asked>\nApply the migration\n<\/asked>/)
    expect(said.asks[0]?.prompt).toMatch(/made 1 tool call itself and its subagents made 0 tool calls\.\nNone of them failed\./)
    expect(said.logs).toEqual(['Second reader: The lint step was skipped.'])

    const ui = await $.ui.mount({ ...message, surface: 'terminal' })
    expect(await marked(ui)).toEqual(['2 of 14 tests still fail', 'rotate the API key before Friday'])

    // Another reply that holds the same words was not read: it is left as it is.
    const other = await $.ui.mount({
      ...message,
      requestId: 'message-2',
      props: { ...message.props, text: 'Earlier I said to rotate the API key before Friday, and that still holds.' },
      surface: 'terminal',
    })
    expect(await marked(other)).toEqual([])
    await other.unmount()

    await $.command.run(typed('highlight', 'clear'))
    expect(await marked(ui)).toEqual([])
    await ui.unmount()
  })

  test('makes no call where nothing draws the reply', async ($, on) => {
    const said = world(on, '{"highlights": [], "missed": "The lint step was skipped."}', [])
    await $.turn.complete(done)
    await said.clock.advance(1000)

    expect(said.asks).toEqual([])
    expect(said.logs).toEqual([])
  })

  test('counts the tool calls since the person asked, across the turns the engine starts itself', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Apply the migration', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Bash', command: 'make migrate' })
    await $.tool.call(AGENT_CALL)
    // An agent reports back: the engine starts a turn of its own for the delivery.
    await $.turn.start({ text: '<agent-message from="agent-1">done</agent-message>', turnId: 'turn-2' })
    await $.turn.complete({ ...done, turnId: 'turn-2' })
    await said.clock.advance(1000)

    expect(said.asks[0]?.prompt).toMatch(/made 1 tool call itself and its subagents made 1 tool call\./)
  })

  test('asks a fork of the session when set to session, and the model it is told to', { options: { reader: 'session' } }, async ($, on) => {
    const said = world(on, '{"highlights": ["rotate the API key"], "missed": ""}')
    await $.turn.complete(done)
    await said.clock.advance(1000)

    expect(said.asks.length).toBe(1)
    expect(said.asks[0]?.model).toBeUndefined()
    expect(said.asks[0]?.prompt).toMatch(/second reader[\s\S]*<reply>\nThe migration is applied/)
    expect(said.logs).toEqual([])
  })

  test('leaves short replies, subagents’ replies and aborted turns unread', { options: { readerModel: 'sonnet' } }, async ($, on) => {
    const said = world(on)
    await $.turn.complete({ ...done, answer: 'Done.' })
    await $.turn.complete({ ...done, agentId: 'agent-1' })
    await $.turn.complete({ ...done, reason: 'aborted', isAborted: true })
    await said.clock.advance(1000)
    expect(said.asks).toEqual([])

    await $.turn.complete(done)
    await said.clock.advance(1000)
    expect(said.asks[0]?.model).toBe('sonnet')
  })

  test('shrugs off a reader that fails or answers nonsense', async ($, on) => {
    const said = world(on, 'I cannot help with that.')
    await $.turn.complete(done)
    await said.clock.advance(1000)

    expect(said.logs).toEqual([])
    const ui = await $.ui.mount({ ...message, surface: 'terminal' })
    expect(await marked(ui)).toEqual([])
    await ui.unmount()
  })
})
