/** What the second reader marked in one reply: the reply's lines, as fingerprints, and the phrases. */
export type Reading = {
  lines: number[]
  phrases: string[]
}

/** One task of a list Claude keeps while it works. */
export type Task = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  /** What it reads as while in progress ("Running tests"). */
  active?: string
  /** When it was first seen in progress and when it was done, in milliseconds of the session's clock. */
  startedAt?: number
  endedAt?: number
  /** The tool calls made while it was in progress, the latest last. */
  calls?: Call[]
  /** The last thing Claude wrote while it was in progress. */
  note?: string
  /** What the model requests made while it was in progress spent, in input-token equivalents. */
  spent?: number
}

/** One tool call a task made: what it acted on and, when it failed, what it said. */
export type Call = {
  at: number
  tool: string
  /** The command, file, pattern or address it was given, one line. */
  what: string
  /** The first lines of its error, when it failed or was refused. */
  error?: string
  /** The subagent that made it, when one did. */
  by?: string
  /** The lines it added to and removed from a file, as its input tells them, when it wrote one. */
  lines?: { added: number; removed: number }
}

/** Which task the panel has open (`<thread>:<id>`, the thread `main` or an agent's id), and on which tab. */
export type View = {
  task: string | null
  tab: 'details' | 'problems' | 'result'
  /** Which tasks the list shows. */
  filter?: Filter
}

/** The tasks a list shows: all, those not done, those with a problem still open, those done. */
export type Filter = 'all' | 'open' | 'problems' | 'done'

/** One subagent as the progress band follows it. */
export type AgentRow = {
  id: string
  label: string
  type: string
  status: 'running' | 'done' | 'failed'
  /** Tool calls it made, and the last one's name. */
  tools: number
  last: string
  /** Tokens its context held at its last model request. */
  context: number
  /** What it has spent so far, in input-token equivalents. */
  used: number
  tasks: Task[]
  /** When it was first heard of and when it ended, in milliseconds of the session's clock. */
  startedAt: number
  endedAt?: number
  /** The first line of what it answered when its run ended. */
  said?: string
}

/** What the progress band draws: the goal, the main thread's tasks and use, and each subagent's. */
export type Board = {
  /** The goal set with /goal, when one is. */
  goal: string | null
  /** The prompt the turn in progress answers. */
  ask: string
  tasks: Task[]
  agents: AgentRow[]
  context: number
  window: number
  used: number
  /** All the session spent, the agents that left the board included. */
  total: number
  limits: { kind: string; percent: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    sentinel: {
      pens: string[]
      readings: Reading[]
      board: Board
      /** The frame the panel's moving marks are drawn at; it counts on only while something moves. */
      frame: number
      isDismissed: boolean
      view: View
    }
  }
}
