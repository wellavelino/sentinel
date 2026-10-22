/** A run of text drawn one way. */
export type Segment = {
  text: string
  isBold?: true
  isItalic?: true
  isCode?: true
  isStruck?: true
  isDim?: true
  isHighlighted?: true
  href?: string
}

/** One drawn line of a block: its hanging prefix (an indent, a list marker, a quote bar) and its text. */
export type Line = {
  prefix: string
  segments: Segment[]
}

/** A stretch of a reply: left to the engine's markdown, or drawn line by line with its marks. */
export type Block = { kind: 'markdown'; text: string } | { kind: 'lines'; lines: Line[] }

export type Layout =
  /** Nothing to highlight: the engine draws `text` (the reply, its unused marks made bold). */
  | { kind: 'plain'; text: string }
  | { kind: 'blocks'; blocks: Block[] }

export type MarkOptions = {
  /** Whether `==phrase==` is a highlight. */
  hasMarks: boolean
  /** Whether bold text is a highlight. */
  hasBold: boolean
  /** The person's own phrases, highlighted wherever a reply's prose holds them. */
  pens: readonly string[]
  /** Phrases highlighted only where they stand as whole words: a reader's, for this reply. */
  whole?: readonly string[]
}

export const MAX_PENS = 50

/** The system prompt section that asks Claude to mark what matters. */
export const INSTRUCTION = `# Highlighter marks

This interface draws text wrapped in double equals signs as a highlighter pen mark: ==like this==.
In a reply to the person, mark the one to three phrases they must not miss: the answer itself, a decision, a key number, a warning, an action they have to take. Keep each mark short (a few words, never a whole paragraph), and mark nothing when no phrase stands out, as in a short reply.
Use the marks only in the prose of your replies: never inside code blocks, inline code, tables, headings, file paths or links, never combined with bold, and never in files, commit messages, tool input or anything another program reads.`

// A mark opens after a blank or an opening bracket and closes before a blank or punctuation:
// a comparison in running text (a==b, "$a"=="$b") is neither. \x60 is the backtick.
const MARK = String.raw`(?<![\w=\x60"'$])==(?=[^\s=])(?<mark>.+?)(?<=[^\s=])==(?![\w=\x60"'$])`
const REST = [
  String.raw`(?<tick>\x60+)(?<code>.+?)\k<tick>(?!\x60)`,
  String.raw`\*\*\*(?=\S)(?<both>.+?)(?<=\S)\*\*\*`,
  String.raw`\*\*(?=\S)(?<bold>.+?)(?<=\S)\*\*`,
  String.raw`(?<![\w_])__(?=\S)(?<underBold>.+?)(?<=\S)__(?![\w_])`,
  String.raw`~~(?=\S)(?<struck>.+?)(?<=\S)~~`,
  String.raw`(?<![\w*])\*(?=[^\s*])(?<italic>.+?)(?<=[^\s*])\*(?![\w*])`,
  String.raw`(?<![\w_])_(?=[^\s_])(?<underItalic>.+?)(?<=[^\s_])_(?![\w_])`,
  String.raw`\[(?<label>[^\]\n]+)\]\((?<target>(?:[^()\s]|\([^()\s]*\))+)\)`,
  String.raw`\\(?<escaped>[\\\x60*_{}[\]()#+\-.!=|>~])`,
].join('|')
const WITH_MARKS = `${MARK}|${REST}`

type Style = Omit<Segment, 'text'>

const isSameStyle = (one: Segment, other: Segment) =>
  one.isBold === other.isBold &&
  one.isItalic === other.isItalic &&
  one.isCode === other.isCode &&
  one.isStruck === other.isStruck &&
  one.isDim === other.isDim &&
  one.isHighlighted === other.isHighlighted &&
  one.href === other.href

/** `segments` with each run of one style as one segment. */
function joined(segments: readonly Segment[]): Segment[] {
  const runs: Segment[] = []

  for (const segment of segments) {
    const last = runs.at(-1)

    if (last !== undefined && isSameStyle(last, segment)) {
      last.text += segment.text
    } else if (segment.text !== '') {
      runs.push({ ...segment })
    }
  }

  return runs
}

/** A line of markdown prose as styled runs. */
export function inline(source: string, options: MarkOptions, style: Style = {}): Segment[] {
  // Matched over the whole line from a moving index, so each match sees what stands before it.
  const pattern = new RegExp(options.hasMarks ? WITH_MARKS : REST, 'g')
  const segments: Segment[] = []
  let from = 0

  for (;;) {
    pattern.lastIndex = from
    const match = pattern.exec(source)

    if (match === null) {
      break
    }

    const found = match.groups ?? {}
    const { mark, code, both, struck, label, target, escaped } = found
    const bold = found.bold ?? found.underBold
    const italic = found.italic ?? found.underItalic

    // A mark that would cut a code span in two is no mark: its == is read as written.
    if (mark !== undefined && (mark.split('`').length - 1) % 2 === 1) {
      segments.push({ ...style, text: source.slice(from, match.index + 2) })
      from = match.index + 2
      continue
    }

    if (match.index > from) {
      segments.push({ ...style, text: source.slice(from, match.index) })
    }

    const strong: Style = options.hasBold ? { isBold: true, isHighlighted: true } : { isBold: true }

    if (mark !== undefined) {
      segments.push(...inline(mark, options, { ...style, isHighlighted: true }))
    } else if (code !== undefined) {
      segments.push({ ...style, isCode: true, text: code.trim() === '' ? code : code.trim() })
    } else if (both !== undefined) {
      segments.push(...inline(both, options, { ...style, ...strong, isItalic: true }))
    } else if (bold !== undefined) {
      segments.push(...inline(bold, options, { ...style, ...strong }))
    } else if (struck !== undefined) {
      segments.push(...inline(struck, options, { ...style, isStruck: true }))
    } else if (italic !== undefined) {
      segments.push(...inline(italic, options, { ...style, isItalic: true }))
    } else if (label !== undefined && target !== undefined) {
      segments.push(...inline(label, options, { ...style, href: target }))

      // The address is drawn beside a label that does not already say it.
      if (label !== target) {
        segments.push({ ...style, isDim: true, text: ` (${target})` })
      }
    } else if (escaped !== undefined) {
      segments.push({ ...style, text: escaped })
    }

    from = match.index + match[0].length
  }

  if (from < source.length) {
    segments.push({ ...style, text: source.slice(from) })
  }

  return joined(segments)
}

const WORD = /[\p{L}\p{N}_]/u

/**
 * `segments` with every occurrence of a phrase highlighted, whatever its case; with `isWhole`,
 * only where it stands as whole words.
 */
export function applyPens(segments: readonly Segment[], pens: readonly string[], isWhole = false): Segment[] {
  const plain = segments.map(segment => segment.text).join('')

  if (pens.length === 0 || plain === '') {
    return [...segments]
  }

  // Folded one unit at a time, so the folded text lines up with the text drawn.
  const fold = (text: string) =>
    Array.from({ length: text.length }, (_, index) => {
      const lower = (text[index] ?? '').toLowerCase()

      return lower.length === 1 ? lower : text[index]
    }).join('')
  const folded = fold(plain)
  const isMarked = new Array<boolean>(plain.length).fill(false)
  let hasAny = false

  for (const pen of pens) {
    const phrase = fold(pen)

    if (phrase.length < 2) {
      continue
    }

    for (let at = folded.indexOf(phrase); at !== -1; at = folded.indexOf(phrase, at + 1)) {
      const end = at + phrase.length
      const isInWord =
        (WORD.test(phrase[0] ?? '') && WORD.test(folded[at - 1] ?? '')) ||
        (WORD.test(phrase.at(-1) ?? '') && WORD.test(folded[end] ?? ''))

      if (!isWhole || !isInWord) {
        isMarked.fill(true, at, end)
        hasAny = true
      }
    }
  }

  if (!hasAny) {
    return [...segments]
  }

  const marked: Segment[] = []
  let offset = 0

  for (const segment of segments) {
    let start = 0

    for (let index = 1; index <= segment.text.length; index += 1) {
      const isEnd = index === segment.text.length

      if (isEnd || isMarked[offset + index] !== isMarked[offset + start]) {
        const piece: Segment = { ...segment, text: segment.text.slice(start, index) }

        if (isMarked[offset + start] === true) {
          piece.isHighlighted = true
        }

        marked.push(piece)
        start = index
      }
    }

    offset += segment.text.length
  }

  return marked
}

/** What a selection or a typed phrase adds to the pens: its lines, trimmed, the short ones dropped. */
export function penPieces(text: string): string[] {
  return text
    .split('\n')
    .map(piece => piece.replace(/\s+/g, ' ').trim())
    .filter(piece => piece.length >= 2 && piece.length <= 400)
}

/** A block of a reply as written: its kind, its lines, and the line of the reply it opens on. */
type Raw = { kind: 'code' | 'table' | 'text'; from: number; lines: string[] }

const FENCE = /^\s*(`{3,}|~{3,})/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/

function split(text: string): Raw[] {
  const lines = text.split('\n')
  const blocks: Raw[] = []
  let open: Raw | null = null

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? ''
    const fence = FENCE.exec(line)?.[1]

    if (fence !== undefined) {
      const block: Raw = { kind: 'code', from: at, lines: [line] }
      const closes = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)

      // A fence still streaming has no closing line yet: it runs to the end.
      for (at += 1; at < lines.length; at += 1) {
        block.lines.push(lines[at] ?? '')

        if (closes.test(lines[at] ?? '')) {
          break
        }
      }

      blocks.push(block)
      open = null
    } else if (isMarkdownRule(line, lines[at + 1])) {
      const block: Raw = { kind: 'table', from: at, lines: [line] }

      for (at += 1; at < lines.length && (lines[at] ?? '').includes('|'); at += 1) {
        block.lines.push(lines[at] ?? '')
      }

      at -= 1
      blocks.push(block)
      open = null
    } else if (line.trim() === '') {
      open = null
    } else if (open === null) {
      // A block that opens four spaces in, and is no list item, is code written by indenting.
      const isIndented = /^(?: {4}|\t)/.test(line) && !ITEM.test(line)
      open = { kind: isIndented ? 'code' : 'text', from: at, lines: [line] }
      blocks.push(open)
    } else {
      open.lines.push(line)
    }
  }

  return blocks
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/

function linesOf(block: Raw, options: MarkOptions): Line[] {
  return block.lines.map(line => {
    const heading = HEADING.exec(line)
    const item = ITEM.exec(line)
    const quote = QUOTE.exec(line)
    let prefix = /^\s*/.exec(line)?.[0] ?? ''
    // A backslash at a line's end only breaks the line, which every line here already does.
    let text = line.trim().replace(/\\$/, '')
    let style: Style = {}

    if (RULE.test(line)) {
      prefix = ''
      text = '───'
      style = { isDim: true }
    } else if (heading !== null) {
      prefix = ''
      text = heading[1] ?? ''
      style = { isBold: true }
    } else if (item !== null) {
      prefix = `${item[1] ?? ''}${/^\d/.test(item[2] ?? '') ? (item[2] ?? '') : '-'} `
      text = item[3] ?? ''
    } else if (quote !== null) {
      prefix = '▎ '
      text = quote[1] ?? ''
    }

    // A heading is bold as a heading, never highlighted as bold text.
    const runs = inline(text, style.isBold === true ? { ...options, hasBold: false } : options, style)

    return { prefix, segments: applyPens(applyPens(runs, options.pens), options.whole ?? [], true) }
  })
}

/** `==phrase==` as bold, where a mark cannot be drawn (a table's cell). */
function boldMarks(text: string): string {
  return text.replace(new RegExp(MARK, 'g'), '**$<mark>**')
}

/** A line of markdown prose as it is drawn: its symbols gone. */
export function shownText(source: string): string {
  return inline(source, { hasMarks: true, hasBold: false, pens: [] })
    .map(segment => segment.text)
    .join('')
}

/** The prose of a reply as it is drawn, line by line: no markdown symbols, no code blocks, no tables. */
export function shownLines(text: string): string[] {
  const options: MarkOptions = { hasMarks: true, hasBold: false, pens: [] }

  return split(text)
    .filter(raw => raw.kind === 'text')
    .flatMap(raw => linesOf(raw, options).map(line => line.segments.map(segment => segment.text).join('')))
    .filter(line => line.trim() !== '')
}

/** How a reply is drawn: by the engine alone, or in blocks, those with highlights by line. */
export function layout(text: string, options: MarkOptions): Layout {
  const canMark = options.hasMarks && text.includes('==')
  const canBold = options.hasBold && (text.includes('**') || text.includes('__'))

  if (!canMark && !canBold && options.pens.length === 0 && (options.whole ?? []).length === 0) {
    return { kind: 'plain', text }
  }

  const raws = split(text)
  const blocks: Block[] = []
  let hasLines = false

  for (const raw of raws) {
    const lines = raw.kind === 'text' ? linesOf(raw, options) : []
    const last = blocks.at(-1)

    if (lines.some(line => line.segments.some(segment => segment.isHighlighted === true))) {
      blocks.push({ kind: 'lines', lines })
      hasLines = true
      continue
    }

    const source = raw.lines.join('\n')
    const drawn = raw.kind === 'table' && options.hasMarks ? boldMarks(source) : source

    if (last?.kind === 'markdown') {
      last.text += `\n\n${drawn}`
    } else {
      blocks.push({ kind: 'markdown', text: drawn })
    }
  }

  if (hasLines) {
    return { kind: 'blocks', blocks }
  }

  if (!canMark) {
    return { kind: 'plain', text }
  }

  // No highlight anywhere: the engine draws the reply as written, a table's marks made bold.
  const lines = text.split('\n')

  for (const raw of raws) {
    if (raw.kind === 'table') {
      raw.lines.forEach((line, index) => {
        lines[raw.from + index] = boldMarks(line)
      })
    }
  }

  return { kind: 'plain', text: lines.join('\n') }
}

/** Whether `rule` is the line under a markdown table's `header`: dashes, colons and bars, a cell each. */
function isMarkdownRule(header: string | undefined, rule: string | undefined): boolean {
  if (header === undefined || rule === undefined || !header.includes('|') || !rule.includes('|')) {
    return false
  }

  // Only dashes, colons, bars and blanks: checked first, so no long line is searched for more.
  if (!/^[\s|:-]+$/.test(rule) || !rule.includes('-')) {
    return false
  }

  const parts = rule.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  const cells = header.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)

  return parts.every(part => /^\s*:?-+:?\s*$/.test(part)) && cells.length === parts.length
}
