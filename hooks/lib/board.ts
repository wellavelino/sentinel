import type { AgentRow, Board, Call, Task } from '../../types'

export const EMPTY: Board = {
  goal: null,
  ask: '',
  tasks: [],
  agents: [],
  context: 0,
  window: 0,
  used: 0,
  total: 0,
  limits: [],
}

/** The task tool the mod offers where the session has none: it takes a todo list whole. */
export const TASKS_TOOL = 'mcp__sentinel__tasks'

const MAX_AGENTS = 24
const MAX_TASKS = 200
const MAX_LABEL = 120
const MAX_CALLS = 60
const MAX_NOTE = 600
const MAX_ERROR_LINES = 8
const MAX_ERROR = 600

/** What one model request reports of its cost, as the API counts it. */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** The tokens a context holds after the request `usage` reports: all it read, and what it wrote. */
export function filled(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens +
    usage.output_tokens
  )
}

/**
 * What a request spent, in input-token equivalents: output counts five times an input token,
 * a cache write one and a quarter, a cache read a tenth, as the API's prices relate them.
 */
export function spent(usage: Usage): number {
  return (
    usage.input_tokens +
    5 * usage.output_tokens +
    1.25 * usage.cache_creation_input_tokens +
    0.1 * usage.cache_read_input_tokens
  )
}

const headline = (text: string) => {
  const line = text.trim().split('\n')[0]?.trim() ?? ''

  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line
}

// A slash command is one word after the slash: a path (/etc/hosts) has a second slash in it.
const COMMAND = /^\/[a-z][\w:-]*(\s|$)/i
const DELIVERY =
  /^<(agent-message|task-notification|system-reminder|teammate-message|cross-session-message|local-command-[\w-]+|command-[\w-]+)[\s>]/

/**
 * Whether a turn's opening text is the person asking for something. A turn the engine starts for
 * a slash command or a delivery (an agent's message, a task's notification) is not.
 */
export function isAsk(text: string): boolean {
  const opening = text.trimStart()

  return opening !== '' && !COMMAND.test(opening) && !DELIVERY.test(opening)
}

/** A new prompt: it names the work until a goal does, and clears what the last turn finished. */
export function asked(board: Board, text: string): Board {
  if (!isAsk(text)) {
    return board
  }

  const isDone = board.tasks.length > 0 && board.tasks.every(task => task.status === 'completed')

  return {
    ...board,
    ask: headline(text),
    tasks: isDone ? [] : board.tasks,
    agents: board.agents.filter(agent => agent.status === 'running'),
  }
}

/** The goal as /goal was given it: its words, or none when it was cleared. */
export function aimed(board: Board, args: string): Board {
  const text = args.trim()

  if (text === '') {
    return board
  }

  return { ...board, goal: /^(clear|off|none|stop|cancel|reset|done)$/i.test(text) ? null : headline(text) }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
// A task's words as the board keeps them: one line, a line long at most.
const words = (value: unknown) => headline(text(value))
const status = (value: unknown): Task['status'] =>
  value === 'in_progress' || value === 'completed' ? value : 'pending'

/**
 * `tasks` after one call of a task tool (TodoWrite, TaskCreate, TaskUpdate, TaskList); any other
 * tool leaves them.
 */
export function tasked(tasks: readonly Task[], tool: string, input: unknown, result: unknown): Task[] {
  const given = record(input)

  if ((tool === 'TodoWrite' || tool === TASKS_TOOL) && Array.isArray(given.todos)) {
    return given.todos.slice(0, MAX_TASKS).map((todo, index) => {
      const one = record(todo)

      return {
        id: String(index),
        subject: words(one.content),
        status: status(one.status),
        active: words(one.activeForm) || undefined,
      }
    })
  }

  const listed = record(result).tasks

  // An empty list says nothing: a list kept from todos stays as it is.
  if (tool === 'TaskList' && Array.isArray(listed) && listed.length > 0) {
    return listed.slice(0, MAX_TASKS).map(entry => {
      const one = record(entry)
      const id = text(one.id)

      // The list names no task's words for while it runs: those heard at its making are kept.
      return { id, subject: words(one.subject), status: status(one.status), active: tasks.find(task => task.id === id)?.active }
    })
  }

  if (tool === 'TaskCreate') {
    const id = text(record(record(result).task).id)

    return id === '' || tasks.some(task => task.id === id)
      ? [...tasks]
      : [
          ...tasks,
          { id, subject: words(given.subject), status: 'pending' as const, active: words(given.activeForm) || undefined },
        ].slice(-MAX_TASKS)
  }

  if (tool === 'TaskUpdate') {
    const id = text(given.taskId)

    if (id === '' || record(result).success === false) {
      return [...tasks]
    }

    if (given.status === 'deleted') {
      return tasks.filter(task => task.id !== id)
    }

    // A task made before the mod loaded is first heard of here.
    const known = tasks.find(task => task.id === id) ?? { id, subject: `task ${id}`, status: 'pending' as const }
    const changed: Task = {
      ...known,
      subject: words(given.subject) || known.subject,
      status: given.status === undefined ? known.status : status(given.status),
      active: words(given.activeForm) || known.active,
    }

    return tasks.some(task => task.id === id)
      ? tasks.map(task => (task.id === id ? changed : task))
      : [...tasks, changed].slice(-MAX_TASKS)
  }

  return [...tasks]
}

const fresh = (id: string, now: number): AgentRow => ({
  id,
  label: '',
  type: '',
  status: 'running',
  tools: 0,
  last: '',
  context: 0,
  used: 0,
  tasks: [],
  startedAt: now,
})

/** `board` with one subagent's row changed, the row made (at `now`) when the agent is first heard of. */
export function withAgent(
  board: Board,
  id: string,
  now: number,
  change: (agent: AgentRow) => AgentRow,
): Board {
  const isKnown = board.agents.some(agent => agent.id === id)
  const agents = (isKnown ? board.agents : [...board.agents, fresh(id, now)]).map(agent =>
    agent.id === id ? change(agent) : agent,
  )

  // A full board lets its oldest finished agent go before any that still runs.
  while (agents.length > MAX_AGENTS) {
    const finished = agents.findIndex(agent => agent.status !== 'running' && agent.id !== id)

    agents.splice(finished === -1 ? 0 : finished, 1)
  }

  return { ...board, agents }
}

/** An agent on the board given its name and type; one that left the board stays gone. */
export function named(board: Board, id: string, label: string, type: string): Board {
  return board.agents.some(agent => agent.id === id)
    ? withAgent(board, id, 0, agent => ({ ...agent, label, type }))
    : board
}

/** The rows still running that the engine no longer runs (`live` holds the ids it does), ended. */
export function reconciled(board: Board, live: readonly string[], now: number): Board {
  const isGone = (agent: AgentRow) => agent.status === 'running' && !live.includes(agent.id)

  return board.agents.some(isGone)
    ? {
        ...board,
        agents: board.agents.map(agent =>
          isGone(agent) ? { ...agent, status: 'done' as const, endedAt: now } : agent,
        ),
      }
    : board
}

/** The board without its tasks and its agents: the goal and the figures stay. */
export function cleared(board: Board): Board {
  return { ...board, tasks: [], agents: [] }
}

/** All the session spent: its count, or for a board kept before it was counted, what the rows hold. */
function all(board: Board): number {
  return Math.max(board.total ?? 0, board.agents.reduce((sum, agent) => sum + agent.used, board.used))
}

/** A model request answered: the context it filled and what it spent, on the main thread or an agent. */
export function stepped(board: Board, agentId: string | undefined, usage: Usage, now: number): Board {
  const total = all(board) + spent(usage)

  if (agentId === undefined) {
    return { ...board, context: filled(usage), used: board.used + spent(usage), total }
  }

  return withAgent({ ...board, total }, agentId, now, agent => ({
    ...agent,
    status: 'running',
    endedAt: undefined,
    context: filled(usage),
    used: agent.used + spent(usage),
  }))
}

/** An agent's run over: how it ended and when. One never heard of leaves the board as it was. */
export function ended(board: Board, agentId: string, status: 'done' | 'failed', now: number): Board {
  return board.agents.some(agent => agent.id === agentId)
    ? withAgent(board, agentId, now, agent => ({ ...agent, status, endedAt: now }))
    : board
}

/**
 * `next`, a list just rebuilt from `before`, with what the board heard of each task kept (its
 * calls, its note, its times) and its times set at `now`: started when first seen in progress,
 * done when first seen completed.
 */
export function carried(before: readonly Task[], next: readonly Task[], now: number): Task[] {
  return next.map(task => {
    // A todo list numbers its tasks by place: the same place with other words is another task.
    const old =
      before.find(one => one.id === task.id && one.subject === task.subject) ??
      before.find(one => one.subject === task.subject)
    const kept: Task = {
      startedAt: old?.startedAt,
      endedAt: old?.endedAt,
      calls: old?.calls,
      note: old?.note,
      ...task,
    }

    return {
      ...kept,
      startedAt: kept.startedAt ?? (task.status === 'pending' ? undefined : now),
      endedAt: task.status === 'completed' ? (kept.endedAt ?? now) : undefined,
    }
  })
}

const retasked = (tasks: readonly Task[], tool: string, input: unknown, result: unknown, now: number) =>
  carried(tasks, tasked(tasks, tool, input, result), now)

/** A tool call an agent or the main thread made: its tasks when it is a task tool, an agent's count. */
export function tooled(
  board: Board,
  agentId: string | undefined,
  tool: string,
  input: unknown,
  result: unknown,
  now: number,
): Board {
  if (agentId === undefined) {
    return { ...board, tasks: retasked(board.tasks, tool, input, result, now) }
  }

  // The task tools keep one list for the session: an agent that reads it, or updates a main task,
  // changes the main list and not its own.
  const id = tool === 'TaskUpdate' ? text(record(input).taskId) : ''
  const row = board.agents.find(agent => agent.id === agentId)
  const isMain =
    tool === 'TaskList' ||
    (id !== '' && board.tasks.some(task => task.id === id) && row?.tasks.some(task => task.id === id) !== true)
  const booked = isMain ? { ...board, tasks: retasked(board.tasks, tool, input, result, now) } : board

  return withAgent(booked, agentId, now, agent => ({
    ...agent,
    tools: agent.tools + 1,
    last: tool.replace(/^mcp__/, '').replace(/__/g, ' '),
    tasks: isMain ? agent.tasks : retasked(agent.tasks, tool, input, result, now),
  }))
}

export type Progress = { done: number; total: number; current: string }

/** How far a task list is: how many are done, and what is being done now. */
export function progress(tasks: readonly Task[]): Progress {
  const current = tasks.find(task => task.status === 'in_progress')

  return {
    done: tasks.filter(task => task.status === 'completed').length,
    total: tasks.length,
    current: current === undefined ? '' : current.active || current.subject,
  }
}

/** The percent of all the session spent that `used` is. */
export function share(board: Board, used: number): number {
  const whole = all(board)

  return whole <= 0 ? 0 : Math.round((used / whole) * 100)
}

/** A bar of `width` cells for a fraction: the filled part and the rest. */
export function bar(fraction: number, width: number): { full: string; rest: string } {
  const held = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  // Any progress shows at least one cell, and only all of it fills the bar.
  const cells = held === 0 ? 0 : held === 1 ? width : Math.min(width - 1, Math.max(1, Math.round(held * width)))

  return { full: '█'.repeat(cells), rest: '░'.repeat(width - cells) }
}

/** A token count as a status line writes it: 950, 48k, 1.2M. */
export function compact(tokens: number): string {
  if (tokens >= 999_500) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }

  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens))
}

/** A stretch of time as a status line writes it: 48s, 1m 12s, 1h 03m. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  return minutes < 60
    ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * The stretch of a task list drawn in `room` rows when it is longer: it opens just before the
 * first task not yet done, so what was just finished, what runs and what comes next all show.
 */
export function nearby(tasks: readonly Task[], room: number): { before: number; shown: Task[]; after: number } {
  if (tasks.length <= room) {
    return { before: 0, shown: [...tasks], after: 0 }
  }

  const open = tasks.findIndex(task => task.status !== 'completed')
  const from = Math.min(Math.max(0, (open === -1 ? tasks.length : open) - 1), tasks.length - room)

  return { before: from, shown: tasks.slice(from, from + room), after: tasks.length - from - room }
}

const LIT = 3

/**
 * A bar of `width` cells for work with no measure: a lit stretch that moves one cell a frame,
 * to the end and back.
 */
export function sweep(width: number, frame: number): { before: string; lit: string; after: string } {
  const lit = Math.min(LIT, width)
  const reach = width - lit
  const step = reach === 0 ? 0 : frame % (2 * reach)
  const at = step > reach ? 2 * reach - step : step

  return { before: '─'.repeat(at), lit: '━'.repeat(lit), after: '─'.repeat(reach - at) }
}

const PULSE = ['░', '▒', '▓', '▒']
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** The cell at a bar's growing edge, at `frame`: it swells and fades while the work goes on. */
export function pulse(frame: number): string {
  return PULSE[frame % PULSE.length] ?? '░'
}

/** The mark of a thread at work, at `frame`. */
export function spinner(frame: number): string {
  return SPINNER[frame % SPINNER.length] ?? '⠋'
}

/** Whether anything on the board is being worked on now: a task in progress, an agent running. */
export function isLive(board: Board): boolean {
  const isDoing = (tasks: readonly Task[]) => tasks.some(task => task.status === 'in_progress')

  return isDoing(board.tasks) || board.agents.some(agent => agent.status === 'running' || isDoing(agent.tasks))
}

const count = (tasks: readonly Task[]) => `${progress(tasks).done} of ${tasks.length} tasks done`
const listed = (tasks: readonly Task[]) =>
  tasks.map(task =>
    task.status === 'completed'
      ? `  ✔ ${task.subject}`
      : task.status === 'in_progress'
        ? `  ▸ ${task.active || task.subject}`
        : `  ○ ${task.subject}`,
  )

/** The board in words, as /progress answers: the objective, every task, every subagent and its own. */
export function summary(board: Board): string {
  if (board.tasks.length === 0 && board.agents.length === 0) {
    return 'Panel opened: no tasks and no subagents on the board yet.'
  }

  const agents = `${board.agents.length} subagent${board.agents.length === 1 ? '' : 's'}`
  const aim = board.goal === null ? board.ask && `◆ Working on: ${board.ask}` : `◆ Goal: ${board.goal}`

  return [
    `Panel opened: ${board.tasks.length === 0 ? 'no tasks' : count(board.tasks)} · ${agents} on the board.`,
    aim,
    ...listed(board.tasks),
    ...board.agents.flatMap(agent => [
      [`↳ ${agent.label || 'agent'}`, agent.status, agent.tasks.length > 0 ? count(agent.tasks) : '']
        .filter(part => part !== '')
        .join(' · '),
      ...listed(agent.tasks),
    ]),
  ]
    .filter(line => line !== '')
    .join('\n')
}

/** Whether the band has anything to say. */
export function hasWork(board: Board): boolean {
  return board.goal !== null || board.tasks.length > 0 || board.agents.length > 0
}

/** What a call was given, in one line: its command, file, pattern or address. */
export function described(input: unknown): string {
  const given = record(input)
  const first = [given.command, given.file_path, given.notebook_path, given.pattern, given.url, given.query, given.description]
    .map(text)
    .find(value => value.trim() !== '')

  return headline(first ?? '')
}

/** What a failed call said, cut to its first lines. */
export function failure(said: string): string {
  const lines = said.trim().split('\n').slice(0, MAX_ERROR_LINES).join('\n')

  return lines.length > MAX_ERROR ? `${lines.slice(0, MAX_ERROR - 1)}…` : lines || 'failed'
}

/**
 * `board` with `change` made to the task a thread has in progress: an agent's own, or where it
 * keeps no list in progress, the main thread's, which it is likely working for.
 */
function onCurrent(board: Board, agentId: string | undefined, change: (task: Task) => Task): Board {
  const apply = (tasks: readonly Task[]) => {
    const at = tasks.findIndex(task => task.status === 'in_progress')

    return at === -1 ? null : tasks.map((task, index) => (index === at ? change(task) : task))
  }

  if (agentId !== undefined) {
    const row = board.agents.find(agent => agent.id === agentId)
    const own = row === undefined ? null : apply(row.tasks)

    if (own !== null) {
      return { ...board, agents: board.agents.map(agent => (agent.id === agentId ? { ...agent, tasks: own } : agent)) }
    }
  }

  const main = apply(board.tasks)

  return main === null ? board : { ...board, tasks: main }
}

/** A tool call booked on the task in progress where it was made; with none in progress, nowhere. */
export function logged(board: Board, agentId: string | undefined, call: Call): Board {
  return onCurrent(board, agentId, task => ({ ...task, calls: [...(task.calls ?? []), call].slice(-MAX_CALLS) }))
}

/** What Claude wrote in a step, kept as the note of the task in progress. */
export function noted(board: Board, agentId: string | undefined, said: string): Board {
  const words = said.trim()

  if (words === '') {
    return board
  }

  return onCurrent(board, agentId, task => ({
    ...task,
    note: words.length > MAX_NOTE ? `${words.slice(0, MAX_NOTE - 1)}…` : words,
  }))
}

export type Problem = Call & { isFixed: boolean }

/** A task's failed calls, each fixed when a later call of the same tool on the same thing went through. */
export function problems(task: Task): Problem[] {
  const calls = task.calls ?? []

  return calls.flatMap((call, index) =>
    call.error === undefined
      ? []
      : [
          {
            ...call,
            isFixed: calls
              .slice(index + 1)
              .some(later => later.error === undefined && later.tool === call.tool && later.what === call.what),
          },
        ],
  )
}

const WRITERS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** What a task came to: the files it changed, the commands it ran, its problems fixed and open. */
export function outcome(task: Task): { files: string[]; commands: number; fixed: number; open: number } {
  const calls = task.calls ?? []
  const found = problems(task)

  return {
    files: [...new Set(calls.filter(call => WRITERS.has(call.tool) && call.error === undefined).map(call => call.what))],
    commands: calls.filter(call => call.tool === 'Bash').length,
    fixed: found.filter(problem => problem.isFixed).length,
    open: found.filter(problem => !problem.isFixed).length,
  }
}

/** A tool's name as a row shows it: an MCP tool without its prefix. */
export function toolName(tool: string): string {
  return tool.replace(/^mcp__/, '').replace(/__/g, ' ')
}
