const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const shortDateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

export function formatDate(epochSeconds: number): string {
  return dateFmt.format(new Date(epochSeconds * 1000))
}

export function formatShortDate(epochSeconds: number): string {
  return shortDateFmt.format(new Date(epochSeconds * 1000))
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** Show paths under the home folder as ~/… (display only; real paths are used everywhere else). */
export function displayPath(path: string, home: string | undefined): string {
  if (!home) return path
  const h = home.replace(/[\\/]+$/, '')
  if (path === h) return '~'
  return path.startsWith(h + '/') || path.startsWith(h + '\\') ? '~' + path.slice(h.length) : path
}
