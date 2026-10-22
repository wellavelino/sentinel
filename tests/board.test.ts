import { describe, expect, test } from 'claude-code/testing'

import { aimed, asked, bar, carried, changed, checks, cleared, clocked, compact, counts, elapsed, EMPTY, ended, filled, filtered, hasWork, isAsk, isLive, logged, named, nearby, noted, outcome, problems, progress, queue, reconciled, share, span, spent, stepped, summary, sweep, tasked, tooled } from '../hooks/lib/board'

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 800 }

describe('usage', () => {
  test('counts what a context holds and what a request spent', () => {
    expect(filled(USAGE)).toBe(42_000)
    expect(spent(USAGE)).toBe(1000 + 1000 + 1000 + 4000)
  })
})

describe('tasked', () => {
  test('takes a todo list whole', () => {
    const tasks = tasked([], 'TodoWrite', {
      todos: [
        { content: 'Write parser', status: 'completed', activeForm: 'Writing parser' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
      ],
    }, {})

    expect(progress(tasks)).toEqual({ done: 1, total: 3, current: 'Writing tests' })
  })

  test('follows tasks as they are created, started, finished and deleted', () => {
    let tasks = tasked([], 'TaskCreate', { subject: 'Fix bug', description: 'x', activeForm: 'Fixing bug' }, { task: { id: '1', subject: 'Fix bug' } })
    tasks = tasked(tasks, 'TaskCreate', { subject: 'Add test', description: 'y' }, { task: { id: '2', subject: 'Add test' } })
    expect(progress(tasks)).toEqual({ done: 0, total: 2, current: '' })

    tasks = tasked(tasks, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true })
    expect(progress(tasks).current).toBe('Fixing bug')

    tasks = tasked(tasks, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true })
    tasks = tasked(tasks, 'TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true })
    expect(progress(tasks)).toEqual({ done: 1, total: 1, current: '' })
  })

  test('learns of a task made before it was watching, and ignores an update that failed', () => {
    const tasks = tasked([], 'TaskUpdate', { taskId: '7', status: 'in_progress', subject: 'Old task' }, { success: true })

    expect(tasks).toEqual([{ id: '7', subject: 'Old task', status: 'in_progress', active: undefined }])
    expect(tasked(tasks, 'TaskUpdate', { taskId: '7', status: 'completed' }, { success: false })).toEqual(tasks)
    expect(tasked(tasks, 'Bash', { command: 'ls' }, {})).toEqual(tasks)
  })
})

describe('the board', () => {
  test('names the work by the prompt, and by the goal once one is set', () => {
    let board = asked(EMPTY, 'Fix the flaky login test\nand tell me why it flaked')
    expect(board.ask).toBe('Fix the flaky login test')
    expect(hasWork(board)).toBe(false)

    board = aimed(board, 'all tests pass on main')
    expect(board.goal).toBe('all tests pass on main')
    expect(hasWork(board)).toBe(true)
    expect(asked(board, '/progress')).toEqual(board)
    expect(asked(board, '<agent-message from="a1">done</agent-message>')).toEqual(board)
    expect(aimed(board, '').goal).toBe('all tests pass on main')
    expect(aimed(board, 'clear').goal).toBe(null)
  })

  test('follows each subagent: its tool calls, its context, and its share of what was spent', () => {
    let board = stepped(EMPTY, undefined, USAGE, 5000)
    board = stepped(board, 'agent-1', { ...USAGE, cache_read_input_tokens: 10_000 }, 5000)
    board = tooled(board, 'agent-1', 'Grep', { pattern: 'x' }, {}, 6000)
    board = tooled(board, 'agent-1', 'mcp__db__query', {}, {}, 7000)

    expect(board.context).toBe(42_000)
    expect(board.agents).toEqual([
      { id: 'agent-1', label: '', type: '', status: 'running', tools: 2, last: 'db query', context: 12_000, used: 4000, tasks: [], startedAt: 5000, endedAt: undefined },
    ])
    expect(share(board, board.used)).toBe(64)
    expect(share(board, board.agents[0]?.used ?? 0)).toBe(36)
    expect(share(EMPTY, 0)).toBe(0)

    const over = ended(board, 'agent-1', 'done', 65_000)
    expect(over.agents[0]).toMatchObject({ status: 'done', startedAt: 5000, endedAt: 65_000 })
    expect(ended(board, 'never-seen', 'failed', 1)).toEqual(board)
  })

  test('keeps an agent’s own task list apart from the main one', () => {
    let board = tooled(EMPTY, undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }] }, {}, 0)
    board = tooled(board, 'agent-1', 'TodoWrite', { todos: [{ content: 'b', status: 'pending', activeForm: 'B' }, { content: 'c', status: 'pending', activeForm: 'C' }] }, {}, 0)

    expect(progress(board.tasks).total).toBe(1)
    expect(progress(board.agents[0]?.tasks ?? []).total).toBe(2)
  })

  test('clears a finished task list and finished agents when the next prompt comes', () => {
    let board = tooled(EMPTY, undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }] }, {}, 0)
    board = stepped(board, 'agent-1', USAGE, 0)
    board = stepped(board, 'agent-2', USAGE, 0)
    board = ended(board, 'agent-1', 'done', 10)

    const next = asked(board, 'next thing')

    expect(next.tasks).toEqual([])
    expect(next.agents.map(agent => agent.id)).toEqual(['agent-2'])
  })
})

describe('the board, the hard cases', () => {
  test('takes a prompt that opens with a path or a tag of its own for an ask', () => {
    for (const text of ['/etc/hosts has a stale entry, fix it', '<div> does not close in index.html', 'Fix it', '/src/app.ts:12 throws']) {
      expect(isAsk(text)).toBe(true)
    }

    for (const text of ['', '  ', '/progress', '/goal ship it', '/plugin:skill arg', '<agent-message from="a1">done</agent-message>', '<task-notification>x</task-notification>', '<system-reminder>x</system-reminder>', '<local-command-stdout>x</local-command-stdout>', '<command-name>/x</command-name>', '<teammate-message teammate_id="a">x</teammate-message>', '<cross-session-message>x</cross-session-message>']) {
      expect(isAsk(text)).toBe(false)
    }
  })

  test('keeps counting what an agent spent after it leaves the board', () => {
    let board = stepped(EMPTY, undefined, USAGE, 0)
    board = stepped(board, 'agent-1', { ...USAGE, cache_read_input_tokens: 10_000 }, 0)
    board = asked(ended(board, 'agent-1', 'done', 10), 'next thing')

    expect(board.agents).toEqual([])
    expect(board.total).toBe(11_000)
    expect(share(board, board.used)).toBe(64)
  })

  test('reads a board kept before the total was counted', () => {
    const { total, ...old } = stepped(stepped(EMPTY, undefined, USAGE, 0), 'agent-1', USAGE, 0)

    expect(total).toBe(14_000)
    expect(share(old as typeof EMPTY, 7000)).toBe(50)
  })

  test('books a subagent’s update of a main task on the main list', () => {
    let board = tooled(EMPTY, undefined, 'TaskCreate', { subject: 'Fix bug' }, { task: { id: '1' } }, 0)
    board = tooled(board, 'agent-1', 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true }, 0)

    expect(progress(board.tasks)).toEqual({ done: 1, total: 1, current: '' })
    expect(board.agents[0]).toMatchObject({ tools: 1, last: 'TaskUpdate', tasks: [] })
  })

  test('makes room for a new agent by letting the oldest finished one go', () => {
    let board = EMPTY

    for (let index = 0; index < 24; index += 1) {
      board = stepped(board, `agent-${index}`, USAGE, index)
    }

    board = ended(board, 'agent-5', 'done', 100)
    board = stepped(board, 'agent-new', USAGE, 200)

    expect(board.agents.length).toBe(24)
    expect(board.agents.some(agent => agent.id === 'agent-5')).toBe(false)
    expect(board.agents.some(agent => agent.id === 'agent-0')).toBe(true)
    expect(board.agents.at(-1)?.id).toBe('agent-new')
  })

  test('names an agent on the board, and never brings back one that left', () => {
    const board = stepped(EMPTY, 'agent-1', USAGE, 0)

    expect(named(board, 'agent-1', 'Review', 'Explore').agents[0]).toMatchObject({ label: 'Review', type: 'Explore' })
    expect(named(EMPTY, 'agent-1', 'Review', 'Explore')).toEqual(EMPTY)
  })

  test('ends the rows of agents the engine no longer runs', () => {
    let board = stepped(EMPTY, 'agent-1', USAGE, 0)
    board = stepped(board, 'agent-2', USAGE, 0)

    const now = reconciled(board, ['agent-2'], 50)

    expect(now.agents.map(agent => [agent.id, agent.status, agent.endedAt])).toEqual([
      ['agent-1', 'done', 50],
      ['agent-2', 'running', undefined],
    ])
  })

  test('forgets the tasks and the agents on a clear, and keeps the figures', () => {
    let board = aimed(stepped(EMPTY, undefined, USAGE, 0), 'ship it')
    board = tooled(board, undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'pending', activeForm: 'A' }] }, {}, 0)
    board = cleared(stepped(board, 'agent-1', USAGE, 0))

    expect(board).toMatchObject({ goal: 'ship it', tasks: [], agents: [], context: 42_000, total: 14_000 })
  })
})

describe('bar', () => {
  test('fills in proportion, shows any progress, and fills up only when done', () => {
    expect(bar(0, 10)).toEqual({ full: '', rest: '░░░░░░░░░░' })
    expect(bar(0.01, 10).full).toBe('█')
    expect(bar(0.5, 10).full).toBe('█████')
    expect(bar(0.99, 10).full).toBe('█████████')
    expect(bar(1, 10)).toEqual({ full: '██████████', rest: '' })
    expect(bar(Number.NaN, 4)).toEqual({ full: '', rest: '░░░░' })
    expect(bar(3, 4).full).toBe('████')
  })
})

describe('compact', () => {
  test('writes a token count short', () => {
    expect([950, 1000, 48_200, 999_600, 1_240_000].map(compact)).toEqual(['950', '1k', '48k', '1.0M', '1.2M'])
  })
})

describe('elapsed', () => {
  test('writes a stretch of time short', () => {
    expect([0, 48_400, 72_000, 3_780_000].map(elapsed)).toEqual(['0s', '48s', '1m 12s', '1h 03m'])
  })
})

describe('the engine’s own task list', () => {
  test('is taken whole, each task keeping what it reads as while in progress', () => {
    const known = tasked([], 'TaskCreate', { subject: 'Fix bug', activeForm: 'Fixing bug' }, { task: { id: '1' } })
    const tasks = tasked(known, 'TaskList', {}, {
      tasks: [
        { id: '1', subject: 'Fix the bug', status: 'in_progress', blockedBy: [] },
        { id: '3', subject: 'Add test', status: 'pending', blockedBy: ['1'] },
      ],
    })

    expect(tasks).toEqual([
      { id: '1', subject: 'Fix the bug', status: 'in_progress', active: 'Fixing bug' },
      { id: '3', subject: 'Add test', status: 'pending', active: undefined },
    ])
    expect(tasked(tasks, 'TaskList', {}, { error: 'no list' })).toEqual(tasks)
    expect(tasked(tasks, 'TaskList', {}, undefined)).toEqual(tasks)
  })

  test('says nothing when it is empty: a list kept from todos stays', () => {
    const tasks = tasked([], 'TodoWrite', { todos: [{ content: 'a', status: 'pending', activeForm: 'A' }] }, {})

    expect(tasked(tasks, 'TaskList', {}, { tasks: [] })).toEqual(tasks)
  })

  test('is the session’s, whoever reads it: a subagent’s reading fills the main list, not its card', () => {
    const listed = { tasks: [{ id: '1', subject: 'Fix bug', status: 'in_progress', blockedBy: [] }] }
    const board = tooled(stepped(EMPTY, 'agent-1', USAGE, 0), 'agent-1', 'TaskList', {}, listed, 0)

    expect(board.tasks.map(task => task.subject)).toEqual(['Fix bug'])
    expect(board.agents[0]).toMatchObject({ tools: 1, tasks: [] })

    // Its later update of that task then lands on the main list too.
    const after = tooled(board, 'agent-1', 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true }, 0)
    expect(progress(after.tasks)).toEqual({ done: 1, total: 1, current: '' })
  })
})

describe('a task’s words', () => {
  test('are kept to a line’s length, however long they were written', () => {
    const long = 'x'.repeat(5000)
    const todo = tasked([], 'TodoWrite', { todos: [{ content: long, status: 'in_progress', activeForm: long }] }, {})[0]
    const made = tasked([], 'TaskCreate', { subject: long, activeForm: long }, { task: { id: '1' } })[0]
    const listed = tasked([], 'TaskList', {}, { tasks: [{ id: '1', subject: long, status: 'pending' }] })[0]
    const updated = tasked([], 'TaskUpdate', { taskId: '9', subject: long, activeForm: long }, { success: true })[0]

    for (const task of [todo, made, listed, updated]) {
      expect(task?.subject.length).toBe(120)
      expect((task?.active ?? '').length).toBeLessThanOrEqual(120)
    }
  })
})

describe('nearby', () => {
  const tasks = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({
    id,
    subject: id,
    status: index < 3 ? ('completed' as const) : ('pending' as const),
  }))

  test('shows a list whole when it fits', () => {
    expect(nearby(tasks, 6)).toEqual({ before: 0, shown: tasks, after: 0 })
  })

  test('opens a list too long to draw just before the first task not done', () => {
    const window = nearby(tasks, 3)

    expect(window.shown.map(task => task.id)).toEqual(['c', 'd', 'e'])
    expect([window.before, window.after]).toEqual([2, 1])
  })

  test('shows the end of a list that is all done', () => {
    const done = tasks.map(task => ({ ...task, status: 'completed' as const }))

    expect(nearby(done, 2).shown.map(task => task.id)).toEqual(['e', 'f'])
  })
})

describe('sweep', () => {
  test('moves a lit stretch along the bar and back, one cell a frame', () => {
    expect(sweep(10, 0)).toEqual({ before: '', lit: '━━━', after: '───────' })
    expect(sweep(10, 3)).toEqual({ before: '───', lit: '━━━', after: '────' })
    expect(sweep(10, 7)).toEqual({ before: '───────', lit: '━━━', after: '' })
    expect(sweep(10, 8).before).toBe('──────')
    expect(sweep(10, 14)).toEqual(sweep(10, 0))
  })

  test('always fills its width, however narrow', () => {
    for (const width of [1, 2, 3, 4, 10]) {
      for (let frame = 0; frame < 30; frame += 1) {
        const { before, lit, after } = sweep(width, frame)

        expect(`${before}${lit}${after}`.length).toBe(width)
      }
    }
  })
})

describe('isLive', () => {
  test('says whether anything on the board is being worked on', () => {
    const waiting = tooled(EMPTY, undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'pending', activeForm: 'A' }] }, {}, 0)
    const working = tooled(EMPTY, undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'in_progress', activeForm: 'A' }] }, {}, 0)
    const running = stepped(EMPTY, 'agent-1', USAGE, 0)

    expect([EMPTY, waiting, working, running, ended(running, 'agent-1', 'done', 5)].map(isLive)).toEqual([false, false, true, true, false])
  })
})

describe('summary', () => {
  test('says there is nothing yet on an empty board', () => {
    expect(summary(EMPTY)).toBe('Panel opened: no tasks and no subagents on the board yet.')
  })

  test('lists the objective, every task and every subagent with its own', () => {
    let board = aimed(asked(EMPTY, 'Ship the parser'), 'all parser tests pass')
    board = tooled(board, undefined, 'TodoWrite', {
      todos: [
        { content: 'Write parser', status: 'completed', activeForm: 'Writing parser' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
      ],
    }, {}, 0)
    board = named(stepped(board, 'agent-1', USAGE, 0), 'agent-1', 'Review the parser', 'Explore')
    board = tooled(board, 'agent-1', 'TodoWrite', { todos: [{ content: 'Read it', status: 'pending', activeForm: 'Reading it' }] }, {}, 0)

    expect(summary(board)).toBe([
      'Panel opened: 1 of 3 tasks done · 1 subagent on the board.',
      '◆ Goal: all parser tests pass',
      '  ✔ Write parser',
      '  ▸ Writing tests',
      '  ○ Ship',
      '↳ Review the parser · running · 0 of 1 tasks done',
      '  ○ Read it',
    ].join('\n'))
  })

  test('names the work by the prompt when there is no goal', () => {
    const board = tooled(asked(EMPTY, 'Fix the login test'), undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }] }, {}, 0)

    expect(summary(board)).toBe('Panel opened: 1 of 1 tasks done · 0 subagents on the board.\n◆ Working on: Fix the login test\n  ✔ a')
  })
})

describe('what a task heard of', () => {
  const todos = (statuses: string[]) =>
    statuses.map((status, index) => ({ content: `Step ${index + 1}`, status, activeForm: `Doing step ${index + 1}` }))

  test('keeps a task’s calls and times across a rebuilt list, and times it at its start and end', () => {
    let board = tooled(EMPTY, undefined, 'TodoWrite', { todos: todos(['in_progress', 'pending']) }, {}, 100)
    board = logged(board, undefined, { at: 150, tool: 'Bash', what: 'npm test' })
    board = noted(board, undefined, '  All green.  ')
    board = tooled(board, undefined, 'TodoWrite', { todos: todos(['completed', 'in_progress']) }, {}, 200)

    expect(board.tasks[0]).toMatchObject({ startedAt: 100, endedAt: 200, note: 'All green.', calls: [{ tool: 'Bash' }] })
    expect(board.tasks[1]).toMatchObject({ startedAt: 200 })
    expect(board.tasks[1]?.calls).toBeUndefined()
  })

  test('takes nothing from a task that had the same place but other words', () => {
    const before = [{ id: '0', subject: 'Old', status: 'completed' as const, calls: [{ at: 1, tool: 'Read', what: 'a' }] }]

    expect(carried(before, [{ id: '0', subject: 'New', status: 'pending' }], 5)[0]?.calls).toBeUndefined()
  })

  test('books an agent’s call on its own task, or on the main one where it keeps none', () => {
    let board = tooled(EMPTY, undefined, 'TodoWrite', { todos: todos(['in_progress']) }, {}, 0)
    board = logged(board, 'agent-1', { at: 1, tool: 'Read', what: 'a.ts', by: 'cleanup' })
    board = tooled(board, 'agent-2', 'TodoWrite', { todos: todos(['in_progress']) }, {}, 2)
    board = logged(board, 'agent-2', { at: 3, tool: 'Read', what: 'b.ts' })

    expect(board.tasks[0]?.calls).toEqual([{ at: 1, tool: 'Read', what: 'a.ts', by: 'cleanup' }])
    expect(board.agents.find(agent => agent.id === 'agent-2')?.tasks[0]?.calls).toEqual([{ at: 3, tool: 'Read', what: 'b.ts' }])
  })

  test('books nothing where no task is in progress', () => {
    const board = tooled(EMPTY, undefined, 'TodoWrite', { todos: todos(['pending']) }, {}, 0)

    expect(logged(board, undefined, { at: 1, tool: 'Read', what: 'a' })).toEqual(board)
  })

  test('counts a failure fixed when the same call later went through', () => {
    const task = {
      id: '0',
      subject: 'Fix',
      status: 'completed' as const,
      calls: [
        { at: 1, tool: 'Bash', what: 'npm test', error: 'FAIL' },
        { at: 2, tool: 'Edit', what: 'a.ts' },
        { at: 3, tool: 'Bash', what: 'make', error: 'boom' },
        { at: 4, tool: 'Bash', what: 'npm test' },
        { at: 5, tool: 'Write', what: 'b.ts' },
        { at: 6, tool: 'Edit', what: 'a.ts' },
      ],
    }

    expect(problems(task).map(problem => [problem.what, problem.isFixed, problem.fixedAt])).toEqual([['npm test', true, 4], ['make', false, undefined]])
    expect(outcome(task)).toEqual({
      files: [
        { path: 'a.ts', added: 0, removed: 0 },
        { path: 'b.ts', added: 0, removed: 0 },
      ],
      commands: 3,
      fixed: 1,
      open: 1,
    })
  })
})

describe('what a task changed and checked', () => {
  test('counts the lines an edit adds and removes', () => {
    expect(changed('Edit', { file_path: 'a.ts', old_string: 'a\nb', new_string: 'a\nb\nc' })).toEqual({ added: 3, removed: 2 })
    expect(changed('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'x\ny', new_string: '' }] })).toEqual({ added: 2, removed: 3 })
    expect(changed('Write', { content: 'one\ntwo\n' })).toEqual({ added: 2, removed: 0 })
    expect(changed('NotebookEdit', { new_source: 'print(1)' })).toEqual({ added: 1, removed: 0 })
    expect(changed('Bash', { command: 'ls' })).toBeUndefined()
    expect(changed('Edit', {})).toEqual({ added: 0, removed: 0 })
  })

  test('adds up the lines each file took, and says how the last command went', () => {
    const task = {
      id: '0',
      subject: 'Fix',
      status: 'completed' as const,
      calls: [
        { at: 1, tool: 'Edit', what: 'a.ts', lines: { added: 4, removed: 1 } },
        { at: 2, tool: 'Bash', what: 'npm test', error: 'FAIL' },
        { at: 3, tool: 'Edit', what: 'a.ts', lines: { added: 2, removed: 2 } },
        { at: 4, tool: 'Write', what: 'b.ts', lines: { added: 9, removed: 0 } },
        { at: 5, tool: 'Bash', what: 'npm test' },
      ],
    }

    expect(outcome(task).files).toEqual([
      { path: 'a.ts', added: 6, removed: 3 },
      { path: 'b.ts', added: 9, removed: 0 },
    ])
    expect(checks(task)).toBe('✓ npm test passed')
    expect(checks({ ...task, calls: task.calls.slice(0, 2) })).toBe('✕ npm test failed')
    expect(checks({ ...task, calls: [] })).toBe('')
  })
})

describe('what a task spent', () => {
  test('books each request on the task in progress where it was made, and keeps it across a rebuilt list', () => {
    const todos = (statuses: string[]) => statuses.map((status, index) => ({ content: `Step ${index + 1}`, status, activeForm: `Doing ${index + 1}` }))
    let board = tooled(EMPTY, undefined, 'TodoWrite', { todos: todos(['in_progress', 'pending']) }, {}, 0)
    board = stepped(board, undefined, USAGE, 1)
    board = stepped(board, undefined, USAGE, 2)
    board = tooled(board, undefined, 'TodoWrite', { todos: todos(['completed', 'in_progress']) }, {}, 3)

    expect(board.tasks.map(task => task.spent)).toEqual([2 * spent(USAGE), undefined])
  })

  test('keeps what a subagent said last when its run ends', () => {
    const board = ended(stepped(EMPTY, 'agent-1', USAGE, 0), 'agent-1', 'done', 5, '  Found 38 refs.\nMore below.')

    expect(board.agents[0]).toMatchObject({ status: 'done', said: 'Found 38 refs.' })
  })
})

describe('the queue', () => {
  const todos = (statuses: string[], name: string) =>
    statuses.map((status, index) => ({ content: `${name} ${index + 1}`, status, activeForm: `Doing ${name} ${index + 1}` }))
  let board = tooled(EMPTY, undefined, 'TodoWrite', { todos: todos(['completed', 'in_progress', 'pending'], 'main') }, {}, 1000)
  board = named(stepped(board, 'agent-1', USAGE, 0), 'agent-1', 'Clean up', 'general-purpose')
  board = tooled(board, 'agent-1', 'TodoWrite', { todos: todos(['completed'], 'clean') }, {}, 500)
  board = logged(board, undefined, { at: 1200, tool: 'Bash', what: 'make', error: 'boom' })

  test('numbers every thread’s tasks in one list, the main thread first', () => {
    expect(queue(board).map(entry => [entry.n, entry.task.subject, entry.thread.id, entry.thread.label, entry.at])).toEqual([
      [1, 'main 1', 'main', 'main', 0],
      [2, 'main 2', 'main', 'main', 1],
      [3, 'main 3', 'main', 'main', 2],
      [4, 'clean 1', 'agent-1', 'Clean up', 0],
    ])
  })

  test('filters it to the open, the troubled or the done, and counts each', () => {
    const all = queue(board)

    expect(filtered(all, 'all')).toEqual(all)
    expect(filtered(all, 'open').map(entry => entry.n)).toEqual([2, 3])
    expect(filtered(all, 'problems').map(entry => entry.n)).toEqual([2])
    expect(filtered(all, 'done').map(entry => entry.n)).toEqual([1, 4])
    expect(counts(all)).toEqual({ all: 4, open: 2, problems: 1, done: 2 })
  })

  test('times the whole of it from its first start, to now while it runs', () => {
    expect(span(board, 4000)).toBe(3500)
    expect(span(EMPTY, 4000)).toBe(0)

    const done = tooled(board, undefined, 'TodoWrite', { todos: todos(['completed', 'completed', 'completed'], 'main') }, {}, 3000)
    expect(span(ended(done, 'agent-1', 'done', 3000), 9000)).toBe(2500)
  })
})

describe('clocked', () => {
  test('writes a stretch of time as a clock does', () => {
    expect([0, 42_000, 185_000, 3_730_000].map(clocked)).toEqual(['0:00', '0:42', '3:05', '1:02:10'])
  })
})
