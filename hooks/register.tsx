import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Task, View } from '../types'
import {
  aimed,
  asked,
  bar,
  changed,
  cleared,
  compact,
  described,
  elapsed,
  EMPTY,
  ended,
  failure,
  hasWork,
  isAsk,
  isLive,
  logged,
  named,
  nearby,
  noted,
  outcome,
  problems,
  progress,
  pulse,
  reconciled,
  share,
  spinner,
  stepped,
  summary,
  sweep,
  tasked,
  TASKS_TOOL,
  tooled,
  toolName,
} from './lib/board'
import type { Usage } from './lib/board'
import { INSTRUCTION, layout, MAX_PENS, penPieces } from './lib/marks'
import type { Line, Segment } from './lib/marks'
import {
  counted,
  digestText,
  fingerprints,
  forkPrompt,
  NO_CALLS,
  parseReview,
  phrasesFor,
  REVIEW_SYSTEM,
  reviewRequest,
} from './lib/review'

const PANE = 'sentinel'
const MAX_READINGS = 40
const MIN_REVIEWED_REPLY = 200
const MAX_AGENT_ROWS = 6
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])
// What moves in the panel moves four times a second, and each task's own bar is this wide.
const TICK = 250
const TASK_BAR = 10
// The task rows one drawing holds: a longer list shows the stretch around the task in progress.
const MAX_TASK_ROWS = 60
// The calls a task's details draw at once, the latest kept.
const MAX_CALL_ROWS = 30

/** The tab a task opens on: what went wrong where something is still wrong, else what it came to. */
function firstTab(task: Task): View['tab'] {
  if (problems(task).some(problem => !problem.isFixed)) {
    return 'problems'
  }

  return task.status === 'completed' ? 'result' : 'details'
}

const pens = atom({ plugin: 'sentinel', key: 'pens' } as const, [])
const readings = atom({ plugin: 'sentinel', key: 'readings' } as const, [])
const board = atom({ plugin: 'sentinel', key: 'board' } as const, EMPTY)
const frame = atom({ plugin: 'sentinel', key: 'frame' } as const, 0)
const isDismissed = atom({ plugin: 'sentinel', key: 'isDismissed' } as const, false)
const view = atom({ plugin: 'sentinel', key: 'view' } as const, { task: null, tab: 'details', filter: 'all' } as View)

// Highlighter inks: bright enough to read as a pen, dark text on each.
const INKS: Record<string, string> = {
  yellow: '#ffe95c',
  green: '#8dfc8d',
  pink: '#ff9fd6',
  blue: '#8fd6ff',
  orange: '#ffbb66',
}
const INK_TEXT = '#141414'

const OWN_TASKS = new RegExp(`^${TASKS_TOOL}$`)

// The task tool the model is given where Claude Code has none of its own, as the model reads it.
const TASKS_SPEC = {
  name: 'tasks',
  description:
    'Keeps the task list the person watches in their progress panel. Use it for work of three or more steps: call it once with every step "pending", then again whenever a step starts ("in_progress", one at a time) or is finished ("completed"). Always send the whole list. Do not use it for single-step work, or to report results.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Every task of the list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The task, as an instruction: "Run the tests".' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', description: 'The task while it runs: "Running the tests".' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  isDeferred: false,
}

// The next frame of the panel's moving marks, once asked for, and when.
let pending: { timer: { cancel: () => void }; at: number } | null = null
// Whether the task list is being read for the board: a call of the mod's own, not the assistant's.
let isRefreshing = false

/** Reads the engine's own task list onto the board, where the session has the tool for it. */
async function refresh($: EngineInterface): Promise<void> {
  try {
    if (!(await $.tool.list()).some(tool => tool.name === 'TaskList')) {
      return
    }

    isRefreshing = true
    const ran = await $.tool.call({ tool: 'TaskList' })

    if (ran.deny === undefined && ran.isError !== true) {
      await update($, board, held => ({ ...held, tasks: tasked(held.tasks, 'TaskList', {}, ran.result) }))
    }
  } catch {
    // Without the list the board shows what it heard of.
  } finally {
    isRefreshing = false
  }
}

/** Opens the panel, unless the person closed it by hand. */
async function reveal($: EngineInterface): Promise<boolean> {
  if (await read($, isDismissed)) {
    return false
  }

  return (await $.ui.open({ id: PANE, title: 'progress', columns: 72 })).isPlaced
}

/** Books one answered model request on the board: its context and cost, and a new agent's name. */
async function track(
  $: EngineInterface,
  agentId: string | undefined,
  usage: Usage,
  isAuto: boolean,
): Promise<void> {
  const now = await $.clock.now()

  if (agentId === undefined) {
    const { context, rateLimits } = await $.session.usage()
    const limits = rateLimits.map(limit => ({ kind: limit.kind, percent: limit.percentUsed }))

    await update($, board, held => {
      const booked = stepped(held, undefined, usage, now)

      return { ...booked, context: context.tokens ?? booked.context, window: context.window, limits }
    })

    return
  }

  await update($, board, held => stepped(held, agentId, usage, now))
  const row = (await read($, board)).agents.find(agent => agent.id === agentId)

  if (row?.label === '') {
    const info = (await $.agent.list()).find(agent => agent.id === agentId)
    const label = info?.name || info?.description || info?.type || 'agent'

    await update($, board, held => named(held, agentId, label, info?.type ?? ''))

    // A new agent is worth showing; one already on the board is not news.
    if (isAuto) {
      await reveal($)
    }
  }
}

/** Ends the rows of the agents the engine no longer runs: one whose end the mod never heard of. */
async function settle($: EngineInterface): Promise<void> {
  try {
    const live = (await $.agent.list())
      .filter(agent => agent.status !== 'completed' && agent.status !== 'failed' && agent.status !== 'killed')
      .map(agent => agent.id)
    const now = await $.clock.now()

    await update($, board, held => reconciled(held, live, now))
  } catch {
    // Without the engine's list the rows stay as they are.
  }
}

/**
 * Whether a subagent of this session still works and will report back in a later turn. A teammate
 * is left out: one idle waits for a message, and one in a pane of its own may never report again.
 */
async function isAwaitingAgents($: EngineInterface): Promise<boolean> {
  try {
    return (await $.agent.list()).some(
      agent =>
        agent.teammateId === undefined &&
        (agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting'),
    )
  } catch {
    // Without the engine's list the reply is read, as it was before the mod asked.
    return false
  }
}

/**
 * Asks a second reader what in the turn's reply must not be missed, highlights those phrases,
 * and says what the reply left out. `session` asks a fork of the session itself, which has the
 * whole transcript before it; any other mode asks `model`, which sees the reply and a digest.
 */
async function review(
  $: EngineInterface,
  mode: string,
  model: string,
  answer: string,
  digest: string,
): Promise<void> {
  try {
    // Where nothing draws the reply, nobody would see what the reader has to say.
    if ((await $.session.surfaces()).length === 0) {
      return
    }

    const held = await read($, board)
    const reply =
      mode === 'session'
        ? await $.model.fork({ prompt: forkPrompt(answer) })
        : await $.model.complete({
            model,
            system: REVIEW_SYSTEM,
            prompt: reviewRequest(held.goal ?? held.ask, answer, digest),
            maxTokens: 500,
            effort: 'low',
            timeoutMs: 30_000,
          })

    if (!reply.isAnswered) {
      return
    }

    const found = parseReview(reply.text, answer)

    if (found.phrases.length > 0) {
      const reading = { lines: fingerprints(answer), phrases: found.phrases }

      await update($, readings, list => [...list, reading].slice(-MAX_READINGS))
    }

    if (found.missed !== '') {
      $.ui.log(`Second reader: ${found.missed}`)
    }
  } catch {
    // A review that fails costs the person nothing but the review.
  }
}

export const register: Register = (on, options) => {
  const mode = String(options.highlight ?? 'reader')
  const hasMarks = mode === 'claude' || mode === 'both'
  const hasReader = mode === 'reader' || mode === 'both'
  const hasBold = mode === 'bold' || mode === 'both'
  const ink = INKS[String(options.color ?? 'yellow')] ?? '#ffe95c'
  const hasBand = String(options.band ?? 'on') !== 'off'
  const isAuto = String(options.panel ?? 'auto') !== 'manual'
  const hasTasks = String(options.tasks ?? 'auto') !== 'off'
  const reader = String(options.reader ?? 'fast')
  const readerModel = String(options.readerModel ?? 'haiku') || 'haiku'
  // The tool calls since the person last asked, for a reader that cannot see them.
  let digest = NO_CALLS

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Open the panel on the goal, the tasks and every subagent (clear: forget the tasks and agents)',
      argumentHint: '[clear]',
    })
    await $.command.register({
      name: 'highlight',
      description: 'Highlight the text you selected, or a phrase you type (clear: remove your marks)',
      argumentHint: '[phrase | clear]',
    })

    // A session whose model has no task list tool gets the mod's own, so there is a list to show.
    if (hasTasks) {
      try {
        const hasOwn = (await $.tool.list()).some(tool => tool.name === 'TodoWrite' || tool.name === 'TaskCreate')

        if (!hasOwn) {
          await $.tool.register(TASKS_SPEC)
        }
      } catch {
        return next(e)
      }
    }

    return next(e)
  })

  // The mod's own tool is in no table of tools the types know: it is matched by its name's pattern.
  // It only keeps a list for the person to watch, so it needs no asking; a rule against it stands.
  on('tool.check', { tool: OWN_TASKS }, async ($, e, next) => {
    const decided = await next(e)

    return decided.decision === 'ask' ? { ...decided, decision: 'allow' } : decided
  })

  on('tool.call', { tool: OWN_TASKS }, async ($, e) => {
    const given: { todos?: unknown; agentId?: string } = e

    if (!Array.isArray(given.todos)) {
      const text = 'Send the whole list as "todos": an array of { content, status, activeForm }.'

      return { result: text, text, isError: true }
    }

    const now = await $.clock.now()
    let kept: Task[] = []

    await update($, board, held => {
      const booked = tooled(held, e.agentId, TASKS_TOOL, e, {}, now)
      kept = e.agentId === undefined ? booked.tasks : (booked.agents.find(agent => agent.id === e.agentId)?.tasks ?? [])

      return booked
    })

    const { done, total, current } = progress(kept)
    const text = `Task list kept: ${done} of ${total} done${current === '' ? '' : `, now: ${current}`}.`

    // A tool served as an MCP one answers in text.
    return { result: text, text }
  })

  // The highlighter -----------------------------------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    // Where nothing draws the reply (a headless run), the marks would reach a reader raw.
    if (!hasMarks || e.surfaces.length === 0) {
      return composed
    }

    return {
      sections: [
        ...composed.sections,
        { id: 'sentinel:highlight', text: INSTRUCTION, scope: 'session' },
      ],
    }
  })

  on('command.run', { command: 'highlight' }, async ($, e) => {
    const asked = e.args.trim()

    if (asked === 'clear') {
      await update($, pens, () => [])
      await update($, readings, () => [])

      return { text: 'The highlights are removed.' }
    }

    const selected = asked === '' ? ((await $.ui.selection())?.text ?? '') : asked
    const pieces = penPieces(selected)

    if (pieces.length === 0) {
      return {
        text: 'Nothing to highlight: select text in the transcript with the mouse first, or type the phrase after /highlight.',
      }
    }

    await update($, pens, list => [...new Set([...list, ...pieces])].slice(-MAX_PENS))

    return { text: `Highlighted: ${pieces.join(' / ')}` }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true) {
      return next(e)
    }

    // The person's pens mark every reply; a reader's phrases only the reply it read.
    const whole = phrasesFor(await read($, readings), e.props.text)
    const laid = layout(e.props.text, { hasMarks, hasBold, pens: await read($, pens), whole })

    if (laid.kind === 'plain') {
      return laid.text === e.props.text
        ? next(e)
        : next({ ...e, props: { ...e.props, text: laid.text } })
    }

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const run = (segment: Segment) =>
      segment.isHighlighted === true ? (
        <Text
          backgroundColor={ink}
          color={INK_TEXT}
          bold={segment.isBold}
          italic={segment.isItalic}
          strikethrough={segment.isStruck}
        >
          {segment.text}
        </Text>
      ) : (
        <Text
          color={segment.isCode === true ? 'permission' : undefined}
          bold={segment.isBold}
          italic={segment.isItalic}
          dimColor={segment.isDim}
          strikethrough={segment.isStruck}
          underline={segment.href === undefined ? undefined : true}
        >
          {segment.text}
        </Text>
      )
    const row = (line: Line) => (
      <Box flexDirection="row">
        {line.prefix !== '' && (
          <Box flexShrink={0}>
            <Text dimColor={line.prefix.startsWith('▎')}>{line.prefix}</Text>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">{line.segments.map(run)}</Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="row" marginTop={1}>
        <Box width={2} flexShrink={0}>
          <Text color="text">{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
          {laid.blocks.map(block =>
            block.kind === 'markdown' ? (
              <Markdown text={block.text} />
            ) : (
              <Box flexDirection="column">{block.lines.map(row)}</Box>
            ),
          )}
        </Box>
      </Box>
    )
  })

  // The second reader ---------------------------------------------------------------------

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = e.agentId

    try {
      if (agentId !== undefined) {
        const now = await $.clock.now()

        await update($, board, held => ended(held, agentId, e.reason === 'answer' ? 'done' : 'failed', now, e.answer))
      } else if (
        hasReader &&
        e.reason === 'answer' &&
        e.answer.length >= MIN_REVIEWED_REPLY &&
        // While subagents still work, the reply is a plan: the result comes in a later turn.
        !(await isAwaitingAgents($))
      ) {
        const answer = e.answer
        const said = digestText(digest)

        // On a timer, so the turn ends now and the review lands when it is ready.
        $.clock.after(10, () => {
          void review($, reader, readerModel, answer, said)
        })
      }
    } catch {
      return done
    }

    return done
  })

  // The progress band ---------------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    // A subagent's run begins with the Agent call's prompt, not the person's.
    if (e.agentId !== undefined) {
      return next(e)
    }

    // A turn the engine starts (an agent reporting back) carries on the same piece of work.
    if (isAsk(e.text)) {
      digest = NO_CALLS
    }

    try {
      if (isAsk(e.text) && (await read($, board)).agents.some(agent => agent.status === 'running')) {
        await settle($)
      }

      await update($, board, held => asked(held, e.text))
    } catch {
      return next(e)
    }

    return next(e)
  })

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    // Claude Code's own /goal: the band only reads what it was given.
    const ran = await next(e)

    try {
      await update($, board, held => aimed(held, e.args))
    } catch {
      return ran
    }

    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)

    try {
      if (response.usage !== null) {
        await track($, e.agentId, response.usage, isAuto)
      }

      await update($, board, held => noted(held, e.agentId, response.answer))
    } catch {
      return response
    }

    return response
  })

  if (hasBand) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const held = await read($, board)

      if (e.props.hasSurvey || !hasWork(held)) {
        return next(e)
      }

      const { Box, Text } = $.ui.resolve(e)
      const isWide = e.props.bodyColumns >= 100
      const heat = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')
      const meter = (fraction: number, width: number, color: string) => {
        const drawn = bar(fraction, width)

        return (
          <Text>
            <Text color={color}>{drawn.full}</Text>
            <Text dimColor>{drawn.rest}</Text>
          </Text>
        )
      }
      const context = (tokens: number) => {
        if (tokens <= 0) {
          return null
        }

        const percent = held.window > 0 ? Math.round((tokens / held.window) * 100) : null

        return (
          <Box marginLeft={2} flexShrink={0}>
            <Text dimColor>ctx </Text>
            {percent !== null && meter(percent / 100, 5, heat(percent))}
            <Text>
              {percent === null ? '' : ` ${percent}%`}
              {isWide || percent === null ? ` ${compact(tokens)}` : ''}
            </Text>
          </Box>
        )
      }
      const tasks = (list: AgentRow['tasks']) => {
        const { done, total } = progress(list)

        return (
          total > 0 && (
            <Box marginLeft={2} flexShrink={0}>
              {meter(done / total, 10, 'success')}
              <Text>
                {' '}
                {done}/{total}
              </Text>
            </Box>
          )
        )
      }
      const current = progress(held.tasks).current
      // One row is kept for the count of the agents that do not fit.
      const room = Math.max(0, Math.min(MAX_AGENT_ROWS, e.props.maxRows - (current === '' ? 1 : 2) - 1))
      // Those still running first: what is finished waits for the next prompt to leave.
      const agents = [...held.agents].sort(
        (one, other) => Number(other.status === 'running') - Number(one.status === 'running'),
      )
      const drawn = agents.slice(0, room)
      const labelWidth = Math.min(28, drawn.reduce((most, agent) => Math.max(most, [...agent.label].length), 5))

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color="claude">◆ </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate-end">
                {held.goal === null ? held.ask || 'Working' : `Goal: ${held.goal}`}
              </Text>
            </Box>
            {tasks(held.tasks)}
            {context(held.context)}
            {isWide && held.agents.length > 0 && (
              <Box marginLeft={2} flexShrink={0}>
                <Text dimColor>{share(held, held.used)}% of use</Text>
              </Box>
            )}
            {isWide &&
              held.limits
                .filter(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')
                .map(limit => (
                  <Box marginLeft={2} flexShrink={0}>
                    <Text dimColor>{limit.kind === 'five_hour' ? '5h' : '7d'} </Text>
                    <Text color={heat(limit.percent)}>{Math.round(limit.percent)}%</Text>
                  </Box>
                ))}
          </Box>
          {current !== '' && (
            <Text dimColor wrap="truncate-end">
              {'  ▸ '}
              {current}
            </Text>
          )}
          {drawn.map(agent => (
            <Box flexDirection="row">
              <Text dimColor>{'  ↳ '}</Text>
              <Box width={labelWidth} flexShrink={0}>
                <Text dimColor={agent.status !== 'running'} wrap="truncate-end">
                  {agent.label || 'agent'}
                </Text>
              </Box>
              <Box marginLeft={2} flexGrow={1} flexShrink={1}>
                <Text color={agent.status === 'failed' ? 'error' : undefined} dimColor wrap="truncate-end">
                  {agent.status}
                  {agent.tools > 0 ? ` · ${agent.tools} tool${agent.tools === 1 ? '' : 's'}` : ''}
                  {agent.status === 'running' && agent.last !== '' ? ` · ${agent.last}` : ''}
                </Text>
              </Box>
              {tasks(agent.tasks)}
              {context(agent.context)}
              {isWide && (
                <Box marginLeft={2} flexShrink={0}>
                  <Text dimColor>{share(held, agent.used)}% of use</Text>
                </Box>
              )}
            </Box>
          ))}
          {agents.length > drawn.length && (
            <Text dimColor>
              {'  '}+{agents.length - drawn.length} more agent{agents.length - drawn.length === 1 ? '' : 's'}
            </Text>
          )}
        </Box>
      )
    })
  }

  // The board's tool calls ---------------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const agentId = e.agentId
    const isFailed = ran.deny !== undefined || ran.isError === true

    // The mod's own task calls are no work of the assistant's, and are booked where they are served.
    if ((isRefreshing && tool === 'TaskList') || tool === TASKS_TOOL) {
      return ran
    }

    // What the mod misses is never worth a tool call: a step of its own that fails is dropped.
    try {
      digest = counted(digest, tool, agentId !== undefined, isFailed ? (ran.deny ?? ran.text ?? '') : undefined)

      const now = await $.clock.now()

      if (agentId !== undefined || TASK_TOOLS.has(tool)) {
        await update($, board, held =>
          tooled(held, agentId, tool, isFailed ? undefined : e, isFailed ? undefined : ran.result, now),
        )
      }

      // Every other call is booked on the task it was made for, so the task can be opened on it.
      if (!TASK_TOOLS.has(tool)) {
        await update($, board, held => {
          const by = agentId === undefined ? undefined : held.agents.find(agent => agent.id === agentId)?.label || 'agent'

          return logged(held, agentId, {
            at: now,
            tool,
            what: described(e),
            error: isFailed ? failure(ran.deny ?? ran.text ?? '') : undefined,
            by,
            lines: isFailed ? undefined : changed(tool, e),
          })
        })
      }
    } catch {
      // The board lags one call behind.
    }

    return ran
  })

  // The panel -----------------------------------------------------------------------------

  on('command.run', { command: 'progress' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, board, cleared)
      await update($, view, (): View => ({ task: null, tab: 'details', filter: 'all' }))

      return { text: 'The tasks and the subagents are forgotten.' }
    }

    await update($, isDismissed, () => false)
    await refresh($)
    await reveal($)

    return { text: summary(await read($, board)) }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // Closed by hand, it stays closed until /progress asks for it again.
    if (e.origin.kind === 'person') {
      await update($, isDismissed, () => true)
    }

    pending?.timer.cancel()
    pending = null

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const work = await read($, board)
    const room = Math.max(20, e.props.bodyColumns)
    const running = work.agents.filter(agent => agent.status === 'running').length
    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text color="claude" bold>
            ◆ sentinel
          </Text>
          {running > 0 && <Text color="claude">● {running} running</Text>}
        </Box>
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(room)}
        </Text>
      </Box>
    )

    const now = await $.clock.now()
    const isMoving = isLive(work)
    const at = isMoving ? await read($, frame) : 0

    // What moves is drawn again a frame later: the write draws the panel, which asks for the
    // next, so the frames stop by themselves when the panel goes or the work is done. A frame
    // asked for long ago never came, and is asked for again.
    if (isMoving && (pending === null || now - pending.at > 8 * TICK)) {
      pending?.timer.cancel()

      const timer = $.clock.after(TICK, () => {
        if (pending?.timer === timer) {
          pending = null
        }

        update($, frame, count => count + 1).catch(() => undefined)
      })

      pending = { timer, at: now }
    }

    const span = Math.max(8, Math.min(24, room - 36))
    const heat = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')
    const stat = (name: string, fraction: number | null, color: string, text: string, hasEdge = false) => {
      const drawn = bar(fraction ?? 0, span)
      // The cell a bar grows into next swells and fades while the work on it goes on.
      const edge = hasEdge && drawn.rest !== '' ? pulse(at) : ''

      return (
        <Box flexDirection="row">
          <Box width={9} flexShrink={0}>
            <Text dimColor>{name}</Text>
          </Box>
          {fraction !== null && (
            <Box marginRight={1} flexShrink={0}>
              <Text color={color}>{drawn.full}</Text>
              {edge !== '' && <Text color={color}>{edge}</Text>}
              <Text dimColor>{edge === '' ? drawn.rest : drawn.rest.slice(1)}</Text>
            </Box>
          )}
          <Box flexShrink={1}>
            <Text wrap="truncate-end">{text}</Text>
          </Box>
        </Box>
      )
    }
    const context = (tokens: number, isWhole: boolean) => {
      if (tokens <= 0) {
        return null
      }

      const percent = work.window > 0 ? Math.round((tokens / work.window) * 100) : null
      const size = isWhole && work.window > 0 ? `${compact(tokens)} of ${compact(work.window)}` : compact(tokens)

      return percent === null
        ? stat('context', null, 'success', size)
        : stat('context', percent / 100, heat(percent), `${percent}%  ${size}`)
    }
    const use = (used: number) => {
      const percent = share(work, used)

      return stat('use', percent / 100, 'claude', `${percent}% of session`)
    }
    const steps = (tasks: readonly Task[]) => {
      const { done, total } = progress(tasks)

      return (
        total > 0 &&
        stat('tasks', done / total, 'success', `${done}/${total}`, tasks.some(task => task.status === 'in_progress'))
      )
    }
    // A task has no measure of its own: done is a full bar, in progress a moving one.
    const track = (task: Task) => {
      if (task.status !== 'in_progress') {
        return task.status === 'completed' ? (
          <Text color="success">{'━'.repeat(TASK_BAR)}</Text>
        ) : (
          <Text dimColor>{'─'.repeat(TASK_BAR)}</Text>
        )
      }

      const moving = sweep(TASK_BAR, at)

      return (
        <Text>
          <Text dimColor>{moving.before}</Text>
          <Text color="claude">{moving.lit}</Text>
          <Text dimColor>{moving.after}</Text>
        </Text>
      )
    }
    const mark = (task: Task) =>
      task.status === 'completed' ? (
        <Text color="success">✔</Text>
      ) : task.status === 'in_progress' ? (
        <Text color="claude">▸</Text>
      ) : (
        <Text dimColor>○</Text>
      )
    const opener = (thread: string, task: Task) => () =>
      update($, view, () => ({ task: `${thread}:${task.id}`, tab: firstTab(task) }))
    // Each row opens its task; the main list's first nine answer to their number too.
    const row = (thread: string, tasks: readonly Task[]) => (task: Task) => {
      const place = tasks.indexOf(task)
      const open = problems(task).filter(problem => !problem.isFixed).length

      return (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            {mark(task)}
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Button
              key={`task-${thread}-${task.id}`}
              plain
              hotkey={thread === 'main' && place < 9 ? String(place + 1) : undefined}
              onPress={opener(thread, task)}
            >
              <Text bold={task.status === 'in_progress'} dimColor={task.status === 'completed'}>
                {task.status === 'in_progress' ? task.active || task.subject : task.subject}
              </Text>
              {open > 0 && <Text color="error"> ! {open}</Text>}
            </Button>
          </Box>
          <Box marginLeft={1} flexShrink={0}>
            {track(task)}
          </Box>
        </Box>
      )
    }
    const todos = (thread: string, tasks: readonly Task[], room: number) => {
      const near = nearby(tasks, room)

      return [
        near.before > 0 && <Text dimColor>{`  … ${near.before} done before`}</Text>,
        ...near.shown.map(row(thread, tasks)),
        near.after > 0 && <Text dimColor>{`  … ${near.after} more to do`}</Text>,
      ]
    }

    // A task opened: its calls, its problems and what it came to, one tab at a time.
    const shown = await read($, view)
    const threads = [
      { id: 'main', label: 'main thread', tasks: work.tasks },
      ...work.agents.map(agent => ({ id: agent.id, label: agent.label || 'agent', tasks: agent.tasks })),
    ]
    const opened = threads
      .map(thread => ({ thread, index: thread.tasks.findIndex(task => `${thread.id}:${task.id}` === shown.task) }))
      .find(found => found.index !== -1)

    if (opened !== undefined) {
      const { thread, index } = opened
      const list = thread.tasks
      const task = list[index] as Task
      const calls = task.calls ?? []
      const found = problems(task)
      const open = found.filter(problem => !problem.isFixed).length
      const came = outcome(task)
      const start = task.startedAt ?? calls[0]?.at ?? now
      const took = task.startedAt === undefined ? '' : elapsed((task.endedAt ?? now) - task.startedAt)
      const since = (at: number) => {
        const seconds = Math.max(0, Math.round((at - start) / 1000))

        return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      }
      const step = (by: number) => {
        const next = list[(index + by + list.length) % list.length] as Task

        return () => update($, view, () => ({ task: `${thread.id}:${next.id}`, tab: firstTab(next) }))
      }
      const tab = (name: View['tab'], label: string, hotkey: string) => (
        <Button
          key={`tab-${name}`}
          label={label}
          hotkey={hotkey}
          variant={shown.tab === name ? 'primary' : 'secondary'}
          onPress={() => update($, view, held => ({ ...held, tab: name }))}
        />
      )
      const status =
        task.status === 'completed'
          ? `done${took === '' ? '' : ` in ${took}`}`
          : task.status === 'in_progress'
            ? `in progress${took === '' ? '' : ` · ${took}`}`
            : 'pending'
      const notStarted = task.status === 'pending' && calls.length === 0
      const drawn = calls.slice(-MAX_CALL_ROWS)
      const details = (
        <Box flexDirection="column">
          {task.status === 'in_progress' && task.active !== undefined && (
            <Text color="claude" wrap="truncate-end">
              ▸ {task.active}
            </Text>
          )}
          {calls.length > drawn.length && <Text dimColor>{`… ${calls.length - drawn.length} earlier calls`}</Text>}
          {drawn.map(call => (
            <Box flexDirection="row">
              <Box width={7} flexShrink={0}>
                <Text dimColor>{since(call.at)}</Text>
              </Box>
              <Box width={2} flexShrink={0}>
                {call.error === undefined ? <Text color="success">✔</Text> : <Text color="error">✖</Text>}
              </Box>
              <Box width={11} flexShrink={0}>
                <Text bold wrap="truncate-end">
                  {toolName(call.tool)}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                {/* A path keeps its file name in sight: it is cut in the middle, not at the end. */}
                <Text wrap={call.what.startsWith('/') ? 'truncate-middle' : 'truncate-end'}>{call.what}</Text>
              </Box>
              {call.by !== undefined && (
                <Box marginLeft={1} flexShrink={0}>
                  <Text dimColor>{call.by}</Text>
                </Box>
              )}
            </Box>
          ))}
          {calls.length === 0 && (
            <Text dimColor wrap="wrap">
              {notStarted
                ? 'Not started yet. Its tool calls show here as they run.'
                : 'No tool calls booked on it: it was worked on before the mod loaded, or with none.'}
            </Text>
          )}
        </Box>
      )
      const trouble = (
        <Box flexDirection="column">
          {found.map(problem => (
            <Box flexDirection="column" borderStyle="round" borderColor="error" borderDimColor={problem.isFixed} paddingX={1}>
              <Box flexDirection="row">
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold wrap="truncate-end">
                    <Text color="error">✖ </Text>
                    {toolName(problem.tool)} {problem.what}
                  </Text>
                </Box>
                <Box marginLeft={1} flexShrink={0}>
                  {problem.isFixed ? <Text color="success">fixed later</Text> : <Text color="warning">still open</Text>}
                </Box>
              </Box>
              <Text dimColor>
                at {since(problem.at)}
                {problem.by === undefined ? '' : ` · by ${problem.by}`}
              </Text>
              <Text wrap="wrap">{problem.error}</Text>
            </Box>
          ))}
          {found.length === 0 && (
            <Text dimColor wrap="wrap">
              {notStarted ? 'Not started yet.' : 'No problems: every tool call it made went through.'}
            </Text>
          )}
        </Box>
      )
      const result = notStarted ? (
        <Text dimColor>Not started yet.</Text>
      ) : (
        <Box flexDirection="column">
          {task.status === 'completed' ? (
            <Text color="success">
              ✔ Done{took === '' ? '' : ` in ${took}`} · {calls.length} call{calls.length === 1 ? '' : 's'}
            </Text>
          ) : (
            <Text dimColor wrap="wrap">
              Not done yet: this is what it has come to so far.
            </Text>
          )}
          {task.note !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Claude said</Text>
              <Text wrap="wrap">{task.note}</Text>
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              {came.files.length === 0 ? 'No files changed' : `${came.files.length} file${came.files.length === 1 ? '' : 's'} changed`}
            </Text>
            {came.files.map(file => (
              <Text wrap="truncate-middle">  {file.path}</Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              {came.commands} command{came.commands === 1 ? '' : 's'} run · {came.fixed} problem{came.fixed === 1 ? '' : 's'} fixed
            </Text>
            {came.open > 0 && <Text color="error"> · {came.open} still open</Text>}
          </Box>
        </Box>
      )

      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="row" gap={1}>
            <Button key="back" label="← Tasks" hotkey="b" onPress={() => update($, view, held => ({ ...held, task: null }))} />
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                task {index + 1} of {list.length} · {thread.label}
              </Text>
            </Box>
            {list.length > 1 && <Button key="prev" label="‹" hotkey="k" onPress={step(-1)} />}
            {list.length > 1 && <Button key="next" label="›" hotkey="j" onPress={step(1)} />}
          </Box>
          <Box flexDirection="row" marginTop={1}>
            <Box width={2} flexShrink={0}>
              {mark(task)}
            </Box>
            <Text bold wrap="wrap">
              {task.subject}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {status} · {calls.length} call{calls.length === 1 ? '' : 's'}
          </Text>
          <Box flexDirection="row" gap={1} marginY={1}>
            {tab('details', 'Details', 'd')}
            {tab('problems', open > 0 ? `Problems ${open}` : found.length > 0 ? `Problems ${found.length}` : 'Problems', 'p')}
            {tab('result', 'Result', 'r')}
          </Box>
          {shown.tab === 'problems' ? trouble : shown.tab === 'result' ? result : details}
        </Box>
      )
    }
    // The agents' lists share as many rows as the main list has to itself.
    const listing = work.agents.filter(agent => agent.tasks.length > 0).length
    const agentRows = Math.max(3, Math.floor(MAX_TASK_ROWS / Math.max(1, listing)))
    const limits = work.limits
      .filter(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')
      .map(limit => `${limit.kind === 'five_hour' ? '5h' : '7d'} ${Math.round(limit.percent)}%`)
      .join(' · ')
    // Those still running first, the newest of each kind on top.
    const agents = [...work.agents].reverse().sort(
      (one, other) => Number(other.status === 'running') - Number(one.status === 'running'),
    )

    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text color="claude" bold>
            ◆ {work.goal === null ? 'Working on' : 'Goal'}
          </Text>
          <Text wrap="wrap">{work.goal ?? (work.ask || 'Nothing yet. Your next prompt shows here.')}</Text>
          {work.tasks.length > 0 && <Box marginTop={1}>{steps(work.tasks)}</Box>}
          {todos('main', work.tasks, MAX_TASK_ROWS)}
          {work.tasks.length > 0 && <Text dimColor>Press a task, or its number, for its calls, problems and result.</Text>}
          {work.tasks.length === 0 && (
            <Text dimColor wrap="wrap">
              No task list yet. Claude keeps one for work with several steps, and each task shows here.
            </Text>
          )}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text bold>Main thread</Text>
          {context(work.context, true)}
          {work.agents.length > 0 && use(work.used)}
          {limits !== '' && stat('limits', null, 'success', limits)}
          {work.context <= 0 && limits === '' && <Text dimColor>Figures arrive with the next model request.</Text>}
        </Box>
        {agents.length === 0 && (
          <Box paddingX={1} marginTop={1}>
            <Text dimColor wrap="wrap">
              No subagents yet. Each one Claude starts gets a card here, with its context and its share of
              the session's use.
            </Text>
          </Box>
        )}
        {agents.map(agent => {
          const isRunning = agent.status === 'running'
          const color = isRunning ? 'claude' : agent.status === 'failed' ? 'error' : 'success'
          const began = agent.startedAt ?? now
          const took = elapsed((agent.endedAt ?? now) - began)

          return (
            <Box flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={!isRunning} paddingX={1}>
              <Box flexDirection="row">
                <Box width={2} flexShrink={0}>
                  <Text color={color}>{isRunning ? spinner(at) : agent.status === 'failed' ? '✖' : '✔'}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold wrap="truncate-end">
                    {agent.label || 'agent'}
                  </Text>
                </Box>
                <Box marginLeft={1} flexShrink={0}>
                  <Text color={color} dimColor={!isRunning}>
                    {isRunning ? `running ${took}` : `${agent.status} in ${took}`}
                  </Text>
                </Box>
              </Box>
              <Text dimColor wrap="truncate-end">
                {[
                  agent.type,
                  `${agent.tools} tool${agent.tools === 1 ? '' : 's'}`,
                  isRunning && agent.last !== '' ? `now: ${agent.last}` : '',
                ]
                  .filter(part => part !== '')
                  .join(' · ')}
              </Text>
              {context(agent.context, false)}
              {use(agent.used)}
              {steps(agent.tasks)}
              {todos(agent.id, agent.tasks, agentRows)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
