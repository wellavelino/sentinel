# sentinel

A mod for [Claude Code](https://claude.com/claude-code) that keeps watch over the work while Claude does it:

- **A progress panel.** The goal, every task with its own bar, and a card for the main thread and every subagent: what it is doing, how full its context is, and how much of the session's use is its own.
- **A progress band** above the prompt with the same figures in one line per thread.
- **A highlighter pen**, optional. The phrases that matter in a reply are drawn with a bright background, the way you would mark a page with a pen. A second, small model reads each reply and marks it for you, and tells you what the reply left out. You can add your own marks too, or turn it off in `/config`.

## Install

In a Claude Code terminal session, type:

```
/plugin install sentinel --marketplace wellavelino/mystique
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

| Card | What it shows |
| --- | --- |
| Goal | What you gave Claude Code's own `/goal`; without one, the prompt being worked on. Under it the task list Claude keeps (its todo and task tools): a bar of done over total, then every task with a bar of its own (of a list longer than 60, the stretch around the task in progress). A task has no percent, so a done one is a full bar, a waiting one an empty bar, and the one in progress a bar that moves. |
| Main thread | How full its context window is, its share of what the session spent, and your rate-limit windows (`5h`, `7d`). |
| one per subagent | Its name and type, whether it runs and for how long, its tool calls and the one running now, its context, its share of the session's use, and its own tasks, each with its bar, when it keeps a list. Its mark turns while it runs. Finished agents leave with your next prompt; what they spent stays in the session's total. |

What moves is redrawn four times a second, and only while the panel is on screen and something is in progress. Claude keeps a task list for work with several steps: with none, the Goal card says so.

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
| Task list tool | `auto` (the model gets the mod's task tool where Claude Code gives it none), `off` | `auto` |

## Good to know

- **Your data stays where it is.** The mod makes no network call of its own and writes no file. Marks and the board live in the session's memory and go with it. The second reader is a model call through your own Claude Code session, like any other.
- **The figures are measurements and estimates.** Context is what each thread's last model request held; a subagent's percent is taken against the main thread's window. "Of session" is a thread's share of all the tokens the session spent since the mod loaded, weighed the way the API prices one kind against another (output five times an input token, a cache write one and a quarter, a cache read a tenth). It does not know that one model costs more than another, so read it as a share of the work, not of the bill. A goal stays on the board until you clear it with `/goal clear`.
- **The second reader can be wrong.** The fast one sees the reply and a count of tool calls, not their output. Read its line as a prompt to check, not as a finding. Its marks are drawn only where the reply shows the phrase word for word, as whole words, on one line.
- **The `claude` highlighter adds one short section to the system prompt** (about 120 words) asking for `==marks==`. No other setting touches the prompt. Where nothing draws the reply (`claude -p`), the section is not sent.
- **A paragraph that holds a mark is drawn by the mod**, line by line as the reply wrote it, with its bold, italics, inline code, list markers and links (a link's address is shown beside its label); code blocks, tables and every other paragraph stay the engine's own drawing. A `==mark==` inside a table cell is drawn bold instead, and your own pens do not reach into code blocks or tables.
- Works on every surface that draws mods; built and tried in the terminal.

## Development

```sh
git clone https://github.com/wellavelino/mystique sentinel
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
