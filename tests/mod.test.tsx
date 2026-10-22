import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'sentinel',
  component: 'Pane',
  requestId: 'sentinel',
  props: {
    title: 'progress',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const reply = (text: string) =>
  ({
    plugin: 'sentinel',
    component: 'AssistantMessage',
    requestId: 'message-1',
    props: { text, isFirstOfReply: true },
  }) as const

/** A slash command as the person typing it raises it. */
const typed = (command: string, args: string) =>
  ({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  }) as const

/** The engine beneath the mod: a shell that prints `stdout`, a clock, and a surface that seats panes. */
function world(on: On, stdout: string): { opened: string[] } {
  const opened: string[] = []
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false }, text: stdout }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: opened.length === 0 ? [] : [{ id: 'sentinel', title: 'sentinel', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine drew: {e.props.text}</Text>
  })

  return { opened }
}

describe('the highlighter', () => {
  test('draws a phrase Claude marked with the pen on every surface', { options: { highlight: 'claude' } }, async ($, on) => {
    world(on, '')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...reply('Use ==port 5433== for the replica.'), surface })
      const marked = (await ui.findAll({ type: 'Text' })).filter(text => text.props.backgroundColor !== undefined)

      expect(marked.map(text => text.text)).toEqual(['port 5433'])
      expect(marked[0]?.props.backgroundColor).toBe('#ffe95c')
      expect(await ui.find({ type: 'Text', text: /^engine drew/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('leaves a reply without marks to the engine', async ($, on) => {
    world(on, '')

    const ui = await $.ui.mount({ ...reply('Nothing **special** here.'), surface: 'terminal' })

    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine drew: Nothing **special** here.')
    await ui.unmount()
  })

  test('uses the chosen ink and highlights bold when asked to', { options: { highlight: 'bold', color: 'green' } }, async ($, on) => {
    world(on, '')

    const ui = await $.ui.mount({ ...reply('The **root cause** is ==here==.'), surface: 'terminal' })
    const marked = (await ui.findAll({ type: 'Text' })).filter(text => text.props.backgroundColor !== undefined)

    expect(marked.map(text => [text.text, text.props.backgroundColor])).toEqual([['root cause', '#8dfc8d']])
    await ui.unmount()
  })

  test('highlights what the person typed or selected, and clears it', async ($, on) => {
    world(on, '')
    on('ui.selection', () => ({ value: { text: 'is stale' } }))

    expect((await $.command.run(typed('highlight', 'cache'))).text).toBe('Highlighted: cache')
    expect((await $.command.run(typed('highlight', ''))).text).toBe('Highlighted: is stale')

    const ui = await $.ui.mount({ ...reply('The cache is stale.'), surface: 'terminal' })
    const marked = async () =>
      (await ui.findAll({ type: 'Text' })).filter(text => text.props.backgroundColor !== undefined).map(text => text.text)

    expect(await marked()).toEqual(['cache', 'is stale'])

    await $.command.run(typed('highlight', 'clear'))
    expect(await marked()).toEqual([])
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine drew: The cache is stale.')
    await ui.unmount()
  })

  test('asks Claude for marks only where a surface draws the reply', { options: { highlight: 'claude' } }, async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are helpful.', scope: 'shared' }] }))
    const ask = { model: 'test', promptModel: 'test', tools: [], outputStyle: null, traits: [] }
    const drawn = await $.prompt.compose({ ...ask, surfaces: ['terminal'] })
    const headless = await $.prompt.compose({ ...ask, surfaces: [] })

    expect(drawn.sections.map(section => section.id)).toEqual(['intro', 'sentinel:highlight'])
    expect(drawn.sections.at(-1)?.scope).toBe('session')
    expect(drawn.sections.at(-1)?.text).toMatch(/==like this==/)
    expect(headless.sections.map(section => section.id)).toEqual(['intro'])
  })

  test('leaves the system prompt alone unless Claude is asked for marks, as by default', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are helpful.', scope: 'shared' }] }))
    const composed = await $.prompt.compose({ model: 'test', promptModel: 'test', tools: [], outputStyle: null, traits: [], surfaces: ['terminal'] })

    expect(composed.sections.map(section => section.id)).toEqual(['intro'])
  })

  describe('the task list by default', () => {
    const ask = { model: 'test', promptModel: 'test', outputStyle: null, traits: [], surfaces: ['terminal'] as const }
    const sectioned = async ($: Engine, tools: string[], surfaces: readonly ('terminal' | 'desktop')[] = ['terminal']) =>
      (await $.prompt.compose({ ...ask, tools, surfaces })).sections.find(section => section.id === 'sentinel:tasks')

    test('asks Claude to break work of three or more steps into a list, with the task tool it has', async ($, on) => {
      on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are helpful.', scope: 'shared' }] }))
      const todo = await sectioned($, ['Bash', 'TodoWrite'])
      const created = await sectioned($, ['TaskCreate', 'TaskUpdate'])
      const own = await sectioned($, ['mcp__sentinel__tasks'])

      expect(todo?.scope).toBe('session')
      expect(todo?.text).toMatch(/three or more/)
      expect(todo?.text).toMatch(/your first tool call is TodoWrite/)
      expect(todo?.text).toMatch(/one .*in progress/i)
      expect(todo?.text).toContain('TodoWrite')
      expect(created?.text).toContain('TaskCreate')
      expect(created?.text).toContain('TaskUpdate')
      expect(created?.text).not.toContain('TodoWrite')
      expect(own?.text).toContain('mcp__sentinel__tasks')
    })

    test('asks for no list where the request has no task tool or nothing draws it', async ($, on) => {
      on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are helpful.', scope: 'shared' }] }))

      expect(await sectioned($, ['Bash', 'Read'])).toBeUndefined()
      expect(await sectioned($, ['TodoWrite'], [])).toBeUndefined()
    })

    test('asks for no list when turned off', { options: { breakdown: 'off' } }, async ($, on) => {
      on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are helpful.', scope: 'shared' }] }))

      expect(await sectioned($, ['TodoWrite'])).toBeUndefined()
    })

    test('keeps the highlighter’s section beside it', { options: { highlight: 'claude' } }, async ($, on) => {
      on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are helpful.', scope: 'shared' }] }))
      const composed = await $.prompt.compose({ ...ask, tools: ['TodoWrite'] })

      expect(composed.sections.map(section => section.id)).toEqual(['intro', 'sentinel:tasks', 'sentinel:highlight'])
    })
  })

  test('says so when there is nothing selected to highlight', async ($, on) => {
    world(on, '')
    on('ui.selection', () => ({ value: undefined }))

    expect((await $.command.run(typed('highlight', ''))).text).toMatch(/Nothing to highlight/)
  })
})

describe('the panel', () => {
  test('/progress opens it on the goal and the tasks, and says what is on the board', async ($, on) => {
    const { opened } = world(on, '')
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    expect((await $.command.run(typed('progress', ''))).text).toBe('Panel opened: no tasks and no subagents on the board yet.')
    expect(opened).toEqual(['sentinel'])

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })

      expect(await ui.find({ type: 'Text', text: 'sentinel' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'GOAL' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Nothing yet. Your next prompt shows here.' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /No task list yet/ })).toBeDefined()
      expect(await ui.find({ type: 'Button' })).toBeUndefined()
      await ui.unmount()
    }
  })
})
