import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentStatus, On } from 'claude-code'

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

type Agent = { status: AgentStatus; teammateId?: string }

type Said = { logs: string[]; opened: string[]; asks: { model?: string; prompt: string }[]; calls: string[]; tools: string[]; registered: { name: string; isDeferred?: boolean }[] }

/** The engine beneath the mod: turns, model requests that report `usage`, agents, and a model to ask. */
function world(
  on: On,
  reply = '{"highlights": [], "missed": ""}',
  surfaces: readonly ('terminal' | 'desktop')[] = ['terminal'],
): Said & { clock: ReturnType<typeof mock.clock>; launch: (agentId: string, agent?: Partial<Agent>) => void; loseList: () => void; say: (text: string) => void } {
  const said: Said = { logs: [], opened: [], asks: [], calls: [], tools: [], registered: [] }
  const clock = mock.clock(on, { now: 1000 })
  // The agents the engine runs: each from the first time it is heard of until its run ends.
  const agents = new Map<string, Agent>()
  let isListLost = false
  // What Claude writes in each step from here on.
  let answer = ''
  const heard = (agentId: string | undefined) => {
    if (agentId !== undefined && !agents.has(agentId)) {
      agents.set(agentId, { status: 'running' })
    }
  }
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => {
    if (e.agentId !== undefined) {
      agents.set(e.agentId, { ...agents.get(e.agentId), status: 'completed' })
    }

    return { text: e.answer }
  })
  on('turn.step', async function* ($, e) {
    heard(e.agentId)

    return {
      turnId: e.turnId,
      index: e.index,
      answer,
      toolUses: [],
      stopReason: 'end_turn',
      usage: usage(e.agentId === undefined ? 40_000 : 10_000),
    }
  })
  on('tool.call', ($, e) => {
    said.calls.push(String(e.tool))
    heard(e.agentId)

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
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => {
    said.registered.push({ name: e.name, isDeferred: e.isDeferred })

    return { value: { tool: `mcp__sentinel__${e.name}` } }
  })
  on('session.surfaces', () => ({ value: surfaces }))
  on('agent.list', () => {
    if (isListLost) {
      throw new Error('no agent list')
    }

    return { value: [...agents].map(([id, agent]) => ({ id, description: 'Review the parser', type: 'general-purpose', ...agent })) }
  })
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

  // An agent the engine started that has not reached the mod yet: no step, no tool call.
  const launch = (agentId: string, agent: Partial<Agent> = {}) => {
    agents.set(agentId, { status: 'running', ...agent })
  }
  // The engine cannot list its agents from here on.
  const loseList = () => {
    isListLost = true
  }

  const say = (text: string) => {
    answer = text
  }

  return { ...said, clock, launch, loseList, say }
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

  test('draws the count, the bar, the task in progress by its number and time, the problems and the context', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'boom', text: 'boom', isError: true }))
    const said = world(on)
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
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await drain($.turn.step(step))
    await said.clock.advance(65_000)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

      expect(texts).toContain('1/4')
      expect(texts).toContain('█████')
      expect(texts).toContain('◐ 2. Writing tests')
      expect(texts).toContain('1:05')
      expect(texts).toContain('! 1 problem')
      expect(texts).toContain(' 21%')
      expect(texts).toContain('└ next: 3. Ship')
      // The use and the session limits are the panel's, not the band's.
      expect(texts.some(text => /of use|5h/.test(text))).toBe(false)
      // On a narrow chat the task's name gives way; the mark, its time and the problems never shrink.
      expect((await ui.find({ key: 'band-mark' }))?.props.flexShrink).toBe(0)
      expect((await ui.find({ key: 'band-clock' }))?.props.flexShrink).toBe(0)
      expect((await ui.find({ key: 'band-problems' }))?.props.flexShrink).toBe(0)
      await ui.unmount()
    }

    // Given one row, the band keeps to it.
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 1 }, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(texts).toContain('◐ 2. Writing tests')
    expect(texts.some(text => text.includes('next:'))).toBe(false)
    await ui.unmount()
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

  test("keeps the person's prompt as the work when a subagent's run starts", async ($, on) => {
    world(on)
    await $.turn.start({ text: 'Fix the flaky login test', turnId: 'turn-1' })
    await $.turn.start({ text: 'In this repo, list what the tests do not cover', turnId: 'turn-2', agentId: 'agent-1' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Reproduce', description: 'x' })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(texts).toContain('Fix the flaky login test')
    expect(texts.some(text => /tests do not cover/.test(text))).toBe(false)
    await ui.unmount()
  })

  test('follows each subagent on the second line: its name, how it stands and its time', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Review the parser', turnId: 'turn-1' })
    await drain($.turn.step(step))
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    await $.tool.call(AGENT_CALL)
    await said.clock.advance(72_000)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(await texts()).toContain('Review the parser')
    expect(await texts()).toContain('└ Review the parser')
    expect(await texts()).toContain('◐')
    expect(await texts()).toContain('1:12')

    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-9', agentId: 'agent-1', reason: 'answer' })
    expect(await texts()).toContain('✓')

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

// The moving bars of the tasks in progress, each as the dim part before its lit stretch: what moves.
const sweeps = async (ui: { findAll: (query: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) => {
  const all = await ui.findAll({ type: 'Text' })

  return all.flatMap((text, index) => (text.props.color === 'warning' && /^█{3}$/.test(text.text) ? [all[index - 1]?.text ?? ''] : []))
}

const message = { plugin: 'sentinel', component: 'AssistantMessage', requestId: 'message-1', props: { text: ANSWER, isFirstOfReply: true } } as const

const PANE = {
  plugin: 'sentinel',
  component: 'Pane',
  requestId: 'sentinel',
  props: { title: 'sentinel', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

describe('the agents panel', () => {
  test('opens for a new subagent, and draws the goal, a row a thread and every task in one list', async ($, on) => {
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

      expect(await texts()).toContain('sentinel')
      expect(await texts()).toContain('1/3 · 1:12')
      expect(await texts()).toContain('GOAL')
      expect(await texts()).toContain('all parser tests pass')
      expect(await texts()).toContain('33%')
      // A row a thread: the main one on its task and its context, each agent on what it is at.
      expect(await texts()).toContain('main')
      expect(await texts()).toContain('task 2 · ctx ')
      expect(await texts()).toContain(' 21%')
      expect(await texts()).toContain('Review the parser')
      expect(await texts()).toContain('Bash · 1:12')
      // Every task in one list, numbered, each with when it ran and where.
      expect(await texts()).toContain('Write parser')
      expect(await texts()).toContain('Writing tests')
      expect(await texts()).toContain('1:12 ▸')
      expect(await texts()).toContain('queued')
      expect((await ui.find({ key: 'filter-all' }))?.props.label).toBe('All 3')
      expect((await ui.find({ key: 'filter-done' }))?.props.label).toBe('Done 1')
      expect(await texts()).toContain('1–9 open  f filter  esc back to chat')
      // The cards, the limits and the share of use are gone.
      expect((await texts()).some(text => /Main thread|5h|of session|running 1m/.test(text))).toBe(false)
      await ui.unmount()
    }

    await said.clock.advance(8000)
    await $.turn.complete({ answer: 'found 3 parser bugs', durationMs: 5, isAborted: false, turnId: 'turn-9', agentId: 'agent-1', reason: 'answer' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(texts).toContain('✓')
    expect(texts).toContain('found 3 parser bugs · 1:20')
    await ui.unmount()
  })

  test('shows what a subagent with no list of its own is at: its last tool', async ($, on) => {
    world(on)
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    await $.tool.call({ tool: 'Grep', pattern: 'parse', agentId: 'agent-1' } as never)
    await $.command.run(typed('progress', ''))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect(texts.some(text => /^Grep · \d+:\d\d$/.test(text))).toBe(true)
    await ui.unmount()
  })

  test('cuts a long answer to the row, so the subagent’s spend stays on it', async ($, on) => {
    world(on)
    await drain($.turn.step({ ...step, agentId: 'agent-1' }))
    const answer = `I found three bugs in /home/avelino/shop-api/src/discount.js, ${'and more '.repeat(20)}`
    await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 'turn-9', agentId: 'agent-1', reason: 'answer' })
    await $.command.run(typed('progress', ''))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
    const at = texts.findIndex(text => text.startsWith('I found three bugs'))
    const [row = '', spend = ''] = texts.slice(at, at + 2)

    expect(row).toMatch(/… · \d+:\d\d$/)
    expect(spend).toMatch(/^\d+k$/)
    // The name (12), the mark, three gaps and the spend take the rest of the row.
    expect([...row].length).toBe(PANE.props.bodyColumns - 12 - 1 - 3 - spend.length)
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
  test('lists every task by its number, and moves the bar of the one in progress', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Ship the parser', turnId: 'turn-1' })
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    await $.command.run(typed('progress', ''))

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)
      const moving = async () => (await sweeps(ui))[0]

      // The first nine answer to their number, which their row shows; the rest write it.
      for (const [index, todo] of TODOS.entries()) {
        const line = todo.status === 'in_progress' ? todo.activeForm : todo.content

        expect(await texts()).toContain(index < 9 ? line : `${index + 1}. ${line}`)
        expect((await ui.find({ key: `task-main-${index}` }))?.props.hotkey).toBe(index < 9 ? String(index + 1) : undefined)
      }

      expect((await texts()).some(text => /more to do|done before/.test(text))).toBe(false)
      expect((await texts()).filter(text => text === 'queued').length).toBe(9)
      expect((await sweeps(ui)).length).toBe(1)

      const before = await moving()
      expect(before).toMatch(/^█*$/)

      await said.clock.advance(250)
      expect(await moving()).not.toBe(before)
      await ui.unmount()
    }

    // With the panel gone nothing keeps the frames coming: a look asks for one more, and no more
    // than that one comes however long the panel then stays away.
    const glance = async () => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const at = (await sweeps(ui))[0]?.length
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

    expect(await sweeps(ui)).toEqual([])

    // No frame was counted meanwhile: the first bar to move starts from its first cell.
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS } as never)
    expect(await sweeps(ui)).toEqual([''])
    await ui.unmount()
  })

  test('shows only the tasks a filter lets through, and moves to the next filter on f', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'boom', text: 'boom', isError: true }))
    world(on)
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 4) } as never)
    await $.tool.call({ tool: 'Bash', command: 'make' } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)

    expect((await ui.find({ key: 'filter-problems' }))?.props.label).toBe('Problems 1')
    expect((await ui.find({ key: 'filter-all' }))?.props.variant).toBe('primary')
    // f presses the filter after the one shown.
    expect((await ui.find({ key: 'filter-open' }))?.props.hotkey).toBe('f')
    expect(await texts()).toContain('! 1 problem')

    await ui.press({ key: 'filter-problems' })
    expect((await ui.find({ key: 'filter-problems' }))?.props.variant).toBe('primary')
    expect((await ui.find({ key: 'filter-done' }))?.props.hotkey).toBe('f')
    expect(await ui.find({ key: 'task-main-2' })).toBeDefined()
    expect(await ui.find({ key: 'task-main-0' })).toBeUndefined()

    // A task opened from a filtered list steps within it, and the list comes back filtered.
    await ui.press({ key: 'task-main-2' })
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await ui.press({ key: 'back' })
    expect((await ui.find({ key: 'filter-problems' }))?.props.variant).toBe('primary')
    expect(await ui.find({ key: 'task-main-0' })).toBeUndefined()

    await ui.press({ key: 'filter-done' })
    expect(await ui.find({ key: 'task-main-0' })).toBeDefined()
    expect(await ui.find({ key: 'task-main-2' })).toBeUndefined()
    // Past the last, f goes back to all.
    expect((await ui.find({ key: 'filter-all' }))?.props.hotkey).toBe('f')
    await ui.unmount()
  })

  test('lists a subagent’s own tasks after the main thread’s, under its name', async ($, on) => {
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
    expect(await texts()).toContain('task 2 · 0:00')
    expect((await ui.find({ key: 'task-agent-1-1' }))?.props.hotkey).toBe('2')
    // On the queue, not on the main thread's list.
    expect((await $.command.run(typed('progress', ''))).text).toMatch(/: no tasks ·[\s\S]*↳ Review the parser · running · 1 of 2 tasks done\n  ✔ Read the parser\n  ▸ Writing the report$/)

    const before = await sweeps(ui)
    expect(before.length).toBe(1)
    await said.clock.advance(250)
    expect(await sweeps(ui)).not.toEqual(before)
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

describe('a task opened from the panel', () => {
  test('reads what Claude wrote of a task as Markdown, as the chat does', async ($, on) => {
    const said = world(on)
    said.say('**Fixed** the parser')
    await $.turn.start({ text: 'Ship the parser', turnId: 'turn-1' })
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' }] } as never)
    await drain($.turn.step(step))
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Fix it', status: 'completed', activeForm: 'Fixing it' }] } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'task-main-0' })

    expect((await ui.find({ key: 'tab-result' }))?.props.variant).toBe('primary')
    expect(await ui.find({ type: 'Markdown', text: '**Fixed** the parser' })).toBeDefined()
    await ui.unmount()
  })

  test('shows the calls made while it ran, what failed and whether it was fixed, and what it came to', async ($, on) => {
    // Beneath the mod a test run fails once, then goes through.
    let runs = 0
    on('tool.call', { tool: 'Bash' }, () => {
      runs += 1

      return runs === 1
        ? { result: 'FAIL tests/board.test.ts', text: 'FAIL tests/board.test.ts\n  1 failed', isError: true }
        : { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
    })
    const said = world(on)
    await $.turn.start({ text: 'Ship the parser', turnId: 'turn-1' })
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 4) } as never)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/parser.ts' } as never)
    await said.clock.advance(10_000)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/parser.ts', old_string: 'a', new_string: 'b' } as never)
    await said.clock.advance(20_000)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)

      expect((await ui.find({ key: 'task-main-2' }))?.props.hotkey).toBe('3')

      await ui.press({ key: 'task-main-2' })
      expect(await texts()).toContain('Step 3')
      expect(await texts()).toContain('task 3 of 4')
      expect(await texts()).toContain('In progress · Doing step 3')
      // What it is, at a glance: its thread, when it started, how long it took, its calls, what it spent.
      for (const label of ['thread', 'started', 'time', 'tool calls', 'spent']) {
        expect(await texts()).toContain(label)
      }
      expect(await texts()).toContain('0:30')
      expect(await texts()).toContain('4')
      expect((await ui.find({ key: 'tab-details' }))?.props.variant).toBe('primary')
      expect(await texts()).toContain('◐ Doing step 3')
      expect(await texts()).toContain('src/parser.ts')
      expect(await texts()).toContain('00:30')
      expect((await texts()).filter(text => text === 'npm test').length).toBe(2)
      expect(await texts()).toContain('+1 −1')
      expect(await texts()).toContain('FAIL tests/board.test.ts')
      expect(await texts()).toContain('b tasks  d p r details · problems · result  k j prev/next')

      await ui.press({ key: 'tab-problems' })
      expect((await ui.find({ key: 'tab-problems' }))?.props.label).toBe('Problems 1')
      expect(await texts()).toContain('npm test failed')
      expect(await texts()).toContain('resolved')
      expect(await texts()).toContain('Bash · 00:10')
      expect(await texts()).toContain('FAIL tests/board.test.ts\n  1 failed')
      expect(await texts()).toContain('Went through again at 00:30.')

      await ui.press({ key: 'tab-result' })
      expect(await texts()).toContain('No result yet. It appears here when the task is done: summary, files changed, checks.')

      await ui.press({ key: 'next' })
      expect(await texts()).toContain('Pending · queued after task 3')
      expect(await texts()).toContain('Not started. Tool calls show here as they happen.')

      await ui.press({ key: 'back' })
      expect(await ui.find({ key: 'task-main-0' })).toBeDefined()
      await ui.unmount()
    }

    // Done, the task keeps its calls and opens on what it came to.
    await $.tool.call({
      tool: 'TodoWrite',
      todos: TODOS.slice(0, 4).map((todo, index) => (index === 2 ? { ...todo, status: 'completed' } : todo)),
    } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)
    await ui.press({ key: 'task-main-2' })
    expect((await ui.find({ key: 'tab-result' }))?.props.variant).toBe('primary')
    expect(await texts()).toContain('Done')
    expect(await texts()).toContain('FILES')
    expect(await texts()).toContain('+1')
    expect(await texts()).toContain('−1')
    expect(await texts()).toContain('✓ npm test passed')
    await ui.unmount()
  })

  test('draws a check whose exit code a pipe took as one that ran, not one that passed', async ($, on) => {
    world(on)
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 3) } as never)
    await $.tool.call({ tool: 'Bash', command: 'node --test 2>&1 | tail -40' } as never)
    await $.tool.call({
      tool: 'TodoWrite',
      todos: TODOS.slice(0, 3).map((todo, index) => (index === 2 ? { ...todo, status: 'completed' } : todo)),
    } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text)
    expect((await texts()).some(text => text.includes('node --test ran') && !text.includes('•'))).toBe(true)

    await ui.press({ key: 'task-main-2' })
    const ran = (await ui.findAll({ type: 'Text' })).find(text => text.text === '• node --test ran')
    expect(ran?.props.color).toBeUndefined()
    expect(ran?.props.dimColor).toBe(true)
    expect(await texts()).not.toContain('✓ node --test passed')
    await ui.unmount()
  })

  test('opens on its problems while one is still open, and marks its row', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'boom', text: 'boom', isError: true }))
    world(on)
    await $.tool.call({ tool: 'TodoWrite', todos: TODOS.slice(0, 3) } as never)
    await $.tool.call({ tool: 'Bash', command: 'make' } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toContain('! 1 problem')

    await ui.press({ key: 'task-main-2' })
    expect((await ui.find({ key: 'tab-problems' }))?.props.variant).toBe('primary')
    expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toContain('open')
    await ui.unmount()
  })
})

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
    expect(texts).toContain('101. Doing step 101')
    // A title longer than the row is cut to it, as the design draws it: on one line.
    const title = texts.find(text => text.startsWith('102. Step 102 x')) ?? ''
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThan(PANE.props.bodyColumns)
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

  test('gives the reader the whole prompt, not the line the band shows of it', async ($, on) => {
    const said = world(on)
    const prompt = `Make discount codes work in any case: first add a failing test for welcome10 and run node --test to see it fail, then fix src/discount.js.\nKeep the old codes working.`
    await $.turn.start({ text: prompt, turnId: 'turn-1' })
    await $.tool.call({ tool: 'Bash', command: 'node --test' })
    await $.turn.complete(done)
    await said.clock.advance(1000)

    expect(said.asks[0]?.prompt).toContain(`<asked>\n${prompt}\n</asked>`)
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
    await $.turn.complete({ ...done, agentId: 'agent-1' })
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

  test('waits for the reply that comes once the subagents still running are done', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Apply the migration', turnId: 'turn-1' })
    said.launch('agent-1')
    // The turn ends while the agent works in the background: its reply is a plan, not the result.
    await $.turn.complete(done)
    await said.clock.advance(1000)
    expect(said.asks).toEqual([])

    await $.turn.complete({ ...done, agentId: 'agent-1' })
    await $.turn.start({ text: '<agent-message from="agent-1">done</agent-message>', turnId: 'turn-2' })
    await $.turn.complete({ ...done, turnId: 'turn-2' })
    await said.clock.advance(1000)
    expect(said.asks.length).toBe(1)
  })

  test('reads the reply while the only agents left are teammates, which may never report back', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Apply the migration', turnId: 'turn-1' })
    // One waits for a message; one in a terminal pane of its own still reads `running` after its pane died.
    said.launch('scout@team', { status: 'idle', teammateId: 'scout@team' })
    said.launch('pane@team', { teammateId: 'pane@team' })
    await $.turn.complete(done)
    await said.clock.advance(1000)
    expect(said.asks.length).toBe(1)
  })

  test('reads the reply when the engine cannot list its agents', async ($, on) => {
    const said = world(on)
    await $.turn.start({ text: 'Apply the migration', turnId: 'turn-1' })
    said.loseList()
    await $.turn.complete(done)
    await said.clock.advance(1000)
    expect(said.asks.length).toBe(1)
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
