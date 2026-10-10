/**
 * Pure parser for Git conflict markers (standard and diff3/zdiff3 styles).
 * Dependency-free so it runs in both the main process and the renderer.
 *
 * A marker line is exactly seven marker characters, optionally followed by a
 * space and a label, then the line ending (`\n`, `\r\n` or end of text).
 * Line endings are preserved byte for byte.
 */

export type ConflictSegment =
  | { type: 'text'; text: string }
  | {
      type: 'conflict'
      /** Lines of the "ours" side, including their line endings. */
      ours: string
      /** Lines of the common ancestor (diff3 style only), else null. */
      base: string | null
      theirs: string
      oursLabel: string
      theirsLabel: string
      /** The original text of the whole conflict block, markers included. */
      raw: string
    }

export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'base'

type MarkerKind = 'start' | 'base' | 'sep' | 'end'

/** Split into lines that keep their terminators; the last line may have none. */
function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) {
      if (start < text.length) lines.push(text.slice(start))
      return lines
    }
    lines.push(text.slice(start, nl + 1))
    start = nl + 1
  }
}

function stripEol(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2)
  if (line.endsWith('\n')) return line.slice(0, -1)
  return line
}

const MARKER_CHARS: Record<string, MarkerKind> = { '<': 'start', '|': 'base', '=': 'sep', '>': 'end' }

/** Classify a line as a conflict marker; returns its kind and label, or null. */
function marker(line: string): { kind: MarkerKind; label: string } | null {
  const body = stripEol(line)
  const ch = body[0]
  if (ch === undefined || !(ch in MARKER_CHARS)) return null
  if (body.length < 7 || body.slice(0, 7) !== ch.repeat(7)) return null
  const kind = MARKER_CHARS[ch]!
  if (body.length === 7) return { kind, label: '' }
  // The separator never carries a label.
  if (kind === 'sep' || body[7] !== ' ') return null
  return { kind, label: body.slice(8) }
}

/**
 * Split text into plain text and conflict blocks. Malformed blocks (missing
 * separator or end marker, markers out of order) are kept as plain text.
 */
export function parseConflicts(text: string): ConflictSegment[] {
  const lines = splitLines(text)
  const segments: ConflictSegment[] = []
  let pending = ''
  const flushText = (): void => {
    if (pending) segments.push({ type: 'text', text: pending })
    pending = ''
  }

  let i = 0
  outer: while (i < lines.length) {
    const first = marker(lines[i]!)
    if (first?.kind !== 'start') {
      pending += lines[i]!
      i++
      continue
    }

    // Try to read a complete block starting at line i.
    let phase: 'ours' | 'base' | 'theirs' = 'ours'
    let ours = ''
    let base: string | null = null
    let theirs = ''
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!
      const m = marker(line)
      if (m?.kind === 'start') {
        // A new block opens before this one closed: the first start marker is plain text.
        pending += lines.slice(i, j).join('')
        i = j
        continue outer
      }
      if (m?.kind === 'base' && phase === 'ours') {
        phase = 'base'
        base = ''
        continue
      }
      if (m?.kind === 'sep' && phase !== 'theirs') {
        phase = 'theirs'
        continue
      }
      if (m?.kind === 'end' && phase === 'theirs') {
        flushText()
        segments.push({
          type: 'conflict',
          ours,
          base,
          theirs,
          oursLabel: first.label,
          theirsLabel: m.label,
          raw: lines.slice(i, j + 1).join(''),
        })
        i = j + 1
        continue outer
      }
      if (phase === 'ours') ours += line
      else if (phase === 'base') base += line
      else theirs += line
    }
    // Reached the end without a closing marker: everything from i on is plain text.
    pending += lines.slice(i).join('')
    break
  }
  flushText()
  return segments
}

/**
 * Rebuild the text, replacing conflict number k (counting only conflict
 * segments) according to `choices[k]`. A null or missing choice keeps the
 * original markers. Choosing `base` for a block without a base yields nothing.
 */
export function resolveConflicts(segments: ConflictSegment[], choices: (ConflictChoice | null)[]): string {
  let out = ''
  let k = 0
  for (const seg of segments) {
    if (seg.type === 'text') {
      out += seg.text
      continue
    }
    const choice = choices[k++] ?? null
    switch (choice) {
      case 'ours':
        out += seg.ours
        break
      case 'theirs':
        out += seg.theirs
        break
      case 'both':
        out += seg.ours + seg.theirs
        break
      case 'base':
        out += seg.base ?? ''
        break
      default:
        out += seg.raw
    }
  }
  return out
}

/**
 * True if any line is a conflict start or end marker (`<<<<<<<` / `>>>>>>>`,
 * optionally labelled), even in an incomplete block. A lone `=======` is not
 * counted, since it is common in ordinary text (e.g. setext headings).
 */
export function hasConflictMarkers(text: string): boolean {
  for (const line of splitLines(text)) {
    const m = marker(line)
    if (m && (m.kind === 'start' || m.kind === 'end')) return true
  }
  return false
}
