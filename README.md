# sentinel

A mod for [Claude Code](https://claude.com/claude-code) that keeps watch over the work while Claude does it:

- **A progress panel.** The goal, every task with its own bar, and a card for the main thread and every subagent: what it is doing, how full its context is, and how much of the session's use is its own.
- **A progress band** above the prompt with the same figures in one line per thread.
- **A highlighter pen**, optional. The phrases that matter in a reply are drawn with a bright background, the way you would mark a page with a pen. A second, small model reads each reply and marks it for you, and tells you what the reply left out. You can add your own marks too, or turn it off in `/config`.

## Install

In a Claude Code terminal session, type:

```
/plugin install sentinel --marketplace wellavelino/sentinel
```

Answer `y` to add the marketplace, then pick a scope (the user scope loads it in every session). It is active at once, with no restart.

Requires a Claude Code build with function-hook mods (written against 2.1.296). That API is early access and may change between releases.

## The highlighter

Set **Highlighter** to `off` in `/config` to leave it out: nothing reads or marks your replies, and only marks you make with `/highlight` are drawn.

Models spit a lot of text and in most cases due to lack of attention we miss important details, it highlights things that are important in the context you working

 When a turn ends, a second reader looks at the reply and:

- names up to four phrases you must not miss (the result, a decision made for you, a number that matters, a warning, something you now have to do), which are drawn as pen marks in that reply, and in no other;
- adds one line under the reply when something was left out or played down, such as a command that failed:

```
● sentinel: Second reader: the migration command exited with code 3, which the reply does not mention.
```

Only you see that line; it is not sent to Claude. The review runs after the turn, so it never holds your prompt back. Replies under 200 characters, subagents' replies and interrupted turns are not read, and nothing is read where no surface draws the reply (`claude -p`).

**What it costs.** One extra model call per turn. By default the reader is `haiku` and is given the reply, what you asked for, and a count of the tool calls with the ones that failed: a few thousand tokens. In `/config` you can change the model, or switch the reader to `session`: a fork of the session on its own model, which sees the whole conversation (tool output included) and costs a cached re-read of it. Set the highlighter to `claude` to have the replying model mark its own text instead, with no extra call, or to `off`.

Your own pen:

| Command | What it does |
| --- | --- |
| `/highlight` | Highlights the text you selected with the mouse in the transcript (fullscreen terminal). |
| `/highlight some phrase` | Highlights that phrase wherever the prose of a reply holds it, in any case. Code blocks and tables are left as they are. |
| `/highlight clear` | Removes your marks and the second reader's. The ones Claude wrote into a reply stay. |

Marks last for the session.

## The panel

It opens beside the transcript (docked in the fullscreen layout, above the prompt otherwise) when a subagent starts, or when you ask for it. On a narrow terminal an unasked panel waits instead of taking the screen. Set **Panel** to `manual` in `/config` and it opens only when you ask for it.

| Command | What it does |
| --- | --- |
| `/progress` | Opens the panel on the goal, every task and every subagent, and answers with the same list in words. It reads Claude Code's own task list first, where the session has one. |
| `/progress clear` | Forgets the tasks and the subagents on the board. The goal and the figures stay. |

Give it the keyboard with `ctrl+x tab`; `Esc` hands the keyboard back. Close it with its close mark or `ctrl+x x`; once you close it by hand it stays closed until you ask for it again.

From the top:

| Part | What it shows |
| --- | --- |
| Header | How many tasks are done of all of them, and the time from the first one's start to the last one's end (or now). |
| Goal | What you gave Claude Code's own `/goal`; without one, the prompt being worked on. Under it a bar of done over total, with its percent. |
| Threads | One row a thread: the main thread with the task it is on by its number and a meter of how full its context window is; each subagent with its mark (`◐` running, `✓` done, `✕` failed), its name, the task it is on or its last answer, and how long it ran. Finished agents leave with your next prompt. |
| Filters | `All`, `Open`, `Problems`, `Done`, each with its count; `f` steps to the next. |
| Tasks | Every task of every thread in one numbered list, in the order they were started: its mark, its subject, when it started (`queued` while waiting), and under it a moving bar while it runs, its thread, `! n problems` while one is open, and once done the files it changed and how its last check went. Of a list longer than 30, the stretch around the task in progress. |

### Opening a task

Press any task (or, with the panel focused, its number for the first nine) to open it. Above the tabs: its number in the list, its status (`Done`, `In progress · what it is doing`, `Pending · queued after task n`), its thread, when it started, how long it took, its tool calls and what it spent.

| Tab | Key | What it shows |
| --- | --- | --- |
| Details | `d` | What it is doing now, then every tool call made while it was in progress: its time from the task's start, whether it went through, the tool and what it acted on, the lines it added and removed or the first line of its error, and the subagent that made it. |
| Problems | `p` | One card per call that failed or was refused: what failed, `resolved` when the same call went through afterwards or `open`, where and when, and what it said. A task with an open problem shows `! n problems` in the list. |
| Result | `r` | Once done: the last thing Claude wrote while on it, the files it changed with their lines added and removed, and how its last test or check went. |

A task opens on its problems while one is still open, on its result once done, on its details otherwise. `b` goes back to the list, `k` and `j` step to the previous and next task of the list. Calls are booked on the task in progress of the thread that made them; a subagent with no list of its own books on the main thread's. A task worked on before the mod loaded has no calls to show.

What moves is redrawn four times a second, and only while the panel is on screen and something is in progress. Claude keeps a task list for work with several steps: with none, the Goal card says so.

**Work is broken into tasks by default.** A short section of the system prompt (about 110 words) has Claude open a task list as its first tool call on any request of three or more distinct steps, then work one task at a time, marking each in progress and done as it goes, with whichever task tool the request has. Subagents that have one get the same section. You don't have to ask for a plan to see the work laid out. Set **Break work into tasks** to `off` in `/config` and Claude keeps a list only when it decides to.

**Where the tasks come from.** Claude Code's own task tools (`TodoWrite`, or `TaskCreate` and `TaskUpdate`) where the session's model has them. Where it has none, the mod gives the model one of its own, `mcp__sentinel__tasks`, which only keeps the list for the panel and the band: about 150 tokens of tool description in the prompt, and one short tool call each time a step starts or ends. It needs no permission prompt. Set **Task list tool** to `off` in `/config` to leave it out.

The band above the prompt shows the same in one line per thread; it appears once there is a goal, a task list or a subagent, and can be turned off.

## Settings

`/config` lists these rows for sentinel:

| Setting | Values | Default |
| --- | --- | --- |
| Highlighter | `reader` (a second model marks each reply), `claude` (the replying model marks its own text), `both`, `bold` (every bold phrase), `off` (the highlighter does nothing by itself; only your own `/highlight` marks) | `reader` |
| Pen color | `yellow`, `green`, `pink`, `blue`, `orange` | `yellow` |
| Second reader | `fast` (the model below, given the reply and a tool-call digest), `session` (a fork of the session, which sees everything) | `fast` |
| Second reader model | a model alias or id, used by `fast` | `haiku` |
| Progress band | `on`, `off` | `on` |
| Panel | `auto` (opens for a new subagent), `manual` (opens on `/progress` only) | `auto` |
| Break work into tasks | `on` (Claude writes a task list before work of three or more steps), `off` | `on` |
| Task list tool | `auto` (the model gets the mod's task tool where Claude Code gives it none), `off` | `auto` |

## Good to know

- **Your data stays where it is.** The mod makes no network call of its own and writes no file. Marks and the board live in the session's memory and go with it. The second reader is a model call through your own Claude Code session, like any other.
- **The figures are measurements and estimates.** Context is what the main thread's last model request held, against its window. What a task "spent" is the tokens its model requests used while it was in progress, weighed the way the API prices one kind against another (output five times an input token, a cache write one and a quarter, a cache read a tenth). It does not know that one model costs more than another, so read it as a measure of the work, not of the bill. A goal stays on the board until you clear it with `/goal clear`.
- **The second reader can be wrong.** The fast one sees the reply and a count of tool calls, not their output. Read its line as a prompt to check, not as a finding. Its marks are drawn only where the reply shows the phrase word for word, as whole words, on one line.
- **Two settings add a short section to the system prompt.** The `claude` highlighter adds about 120 words asking for `==marks==`. **Break work into tasks**, on by default, adds about 110 asking for a task list, and only when the request offers a task tool. Where nothing draws the reply (`claude -p`), neither is sent.
- **A paragraph that holds a mark is drawn by the mod**, line by line as the reply wrote it, with its bold, italics, inline code, list markers and links (a link's address is shown beside its label); code blocks, tables and every other paragraph stay the engine's own drawing. A `==mark==` inside a table cell is drawn bold instead, and your own pens do not reach into code blocks or tables.
- Works on every surface that draws mods; built and tried in the terminal.

## Development

```sh
git clone https://github.com/wellavelino/sentinel
claude --plugin-dir ./sentinel      # loads the mod from disk and reloads it on save
```

```sh
claude plugin validate .           # what the engine reads, and all it would refuse
claude plugin test .               # the test suite, run against the engine itself
```

When Claude Code loads the mod from a folder it lays the API's types beside it (`.claude-plugin/types/`, never committed), and `npx -p typescript tsc -p .` type-checks against them.

```
hooks/register.tsx     the hooks: drawing, tracking, commands
hooks/lib/marks.ts     which text is highlighted, and how a marked paragraph is laid out
hooks/lib/review.ts    what the second reader is asked, and reading its answer
hooks/lib/board.ts     the goal, the tasks, the agents, their context and use
types/index.d.ts       the state the mod keeps
tests/                 layout, and the panel, highlighter, band and second reader on terminal and desktop
```

## License

[MIT](LICENSE)
