import type { CommitSummary } from '@shared/types'

export const CONVENTIONAL_TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'perf', 'build', 'ci', 'chore', 'style', 'revert'] as const

const PREFIX_RE = /^([a-z]+)(\([^)]*\))?(!)?:\s*/i

/** True when most recent commits follow Conventional Commits (`type(scope): subject`). */
export function usesConventionalCommits(subjects: readonly string[]): boolean {
  const recent = subjects.filter((s) => !/^Merge /.test(s)).slice(0, 50)
  if (recent.length < 10) return false
  const hits = recent.filter((s) => {
    const m = PREFIX_RE.exec(s)
    return !!m && (CONVENTIONAL_TYPES as readonly string[]).includes(m[1]!.toLowerCase())
  }).length
  return hits / recent.length >= 0.4
}

/** Set the type of a summary, keeping an existing scope and `!`; adds `type: ` when there is none. */
export function applyType(summary: string, type: string): string {
  const m = PREFIX_RE.exec(summary)
  if (!m) return `${type}: ${summary.trimStart()}`
  return `${type}${m[2] ?? ''}${m[3] ?? ''}: ${summary.slice(m[0].length)}`
}

export function currentType(summary: string): string | null {
  const m = PREFIX_RE.exec(summary)
  return m && (CONVENTIONAL_TYPES as readonly string[]).includes(m[1]!.toLowerCase()) ? m[1]!.toLowerCase() : null
}

export interface Person {
  name: string
  email: string
}

/** Recent authors other than `me`, most recent first, one per email (bots and noreply excluded). */
export function recentCoAuthors(commits: readonly CommitSummary[], me: Person | null, limit = 10): Person[] {
  const seen = new Set<string>()
  if (me?.email) seen.add(me.email.toLowerCase())
  const out: Person[] = []
  for (const c of commits) {
    const email = c.authorEmail.trim()
    const key = email.toLowerCase()
    if (!email || seen.has(key) || /\[bot\]|^noreply@|^bot@/i.test(`${c.authorName} ${email}`)) continue
    seen.add(key)
    out.push({ name: c.authorName, email })
    if (out.length >= limit) break
  }
  return out
}

/** Append a `Co-authored-by:` trailer (once), separated from other text by a blank line. */
export function addCoAuthor(description: string, p: Person): string {
  const line = `Co-authored-by: ${p.name} <${p.email}>`
  const lines = description.replace(/\s+$/, '').split('\n')
  if (lines.some((l) => l.trim().toLowerCase() === line.toLowerCase())) return description
  const body = lines.join('\n')
  if (!body) return line
  const lastIsTrailer = /^[A-Za-z-]+: .+/.test(lines[lines.length - 1]!) && lines.slice(-1)[0]!.startsWith('Co-authored-by:')
  return `${body}${lastIsTrailer ? '\n' : '\n\n'}${line}`
}

/** Advice for the summary line, or null when it's fine. */
export function summaryHint(summary: string): string | null {
  const s = summary.trim()
  if (s.length > 72) return 'Long summaries get cut off in many tools. Move details to the description.'
  if (/\.$/.test(s) && !/\.\.\.$/.test(s)) return 'Summaries usually don’t end with a period.'
  return null
}

const DRAFT_PREFIX = 'gitbob.commitDraft:'

export function loadDraft(repoPath: string): { summary: string; description: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(DRAFT_PREFIX + repoPath) ?? 'null') as unknown
    if (v && typeof v === 'object' && typeof (v as { summary?: unknown }).summary === 'string') {
      const d = v as { summary: string; description?: unknown }
      return { summary: d.summary, description: typeof d.description === 'string' ? d.description : '' }
    }
  } catch {
    /* per-viewer convenience */
  }
  return null
}

export function saveDraft(repoPath: string, draft: { summary: string; description: string }): void {
  try {
    if (!draft.summary && !draft.description) localStorage.removeItem(DRAFT_PREFIX + repoPath)
    else localStorage.setItem(DRAFT_PREFIX + repoPath, JSON.stringify(draft))
  } catch {
    /* per-viewer convenience */
  }
}
