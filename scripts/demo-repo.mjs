// Builds a realistic, deterministic demo repository (with a local bare "origin")
// for screenshots. Everything is created with the real git CLI.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const PEOPLE = [
  ['Maya Lindqvist', 'maya@aurora.dev'],
  ['Daniel Okafor', 'daniel@aurora.dev'],
  ['Sofia Marchetti', 'sofia@aurora.dev'],
  ['Kenji Watanabe', 'kenji@aurora.dev'],
  ['Lena Novak', 'lena@aurora.dev'],
]

export function buildDemoRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gitbob-demo-')))
  const home = join(root, 'home')
  mkdirSync(home)
  const origin = join(root, 'origin.git')
  const dir = join(root, 'aurora')
  let clock = Date.UTC(2026, 7, 3, 9, 0) / 1000
  let who = PEOPLE[0]

  const env = () => ({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: who[0],
    GIT_AUTHOR_EMAIL: who[1],
    GIT_COMMITTER_NAME: who[0],
    GIT_COMMITTER_EMAIL: who[1],
    GIT_AUTHOR_DATE: `${clock} +0200`,
    GIT_COMMITTER_DATE: `${clock} +0200`,
  })
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: env(), encoding: 'utf8' }).trim()
  const write = (p, c) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), c)
  }
  const append = (p, c) => appendFileSync(join(dir, p), c)
  const commit = (person, msg, files = {}, hours = 5) => {
    who = PEOPLE[person]
    clock += hours * 3600 + Math.floor((msg.length * 937) % 2400)
    for (const [p, c] of Object.entries(files)) {
      if (c.startsWith('+')) append(p, c.slice(1))
      else write(p, c)
    }
    git('add', '-A')
    git('commit', '-q', '-m', msg)
  }
  const merge = (person, branch, msg) => {
    who = PEOPLE[person]
    clock += 3 * 3600
    git('merge', '-q', '--no-ff', '-m', msg, branch)
  }

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: env() })
  mkdirSync(dir)
  git('init', '-q', '-b', 'main')
  git('remote', 'add', 'origin', origin)

  commit(0, 'Initial commit', { 'README.md': '# Aurora\n\nA tiny weather dashboard.\n', '.gitignore': 'node_modules\ndist\n' })
  commit(0, 'Set up Vite + React + TypeScript', {
    'package.json': '{\n  "name": "aurora",\n  "version": "0.1.0",\n  "private": true\n}\n',
    'src/main.tsx': "import { createRoot } from 'react-dom/client'\nimport { App } from './App'\n\ncreateRoot(document.getElementById('root')!).render(<App />)\n",
    'src/App.tsx': "export function App() {\n  return <h1>Aurora</h1>\n}\n",
  })
  commit(1, 'Add forecast API client', {
    'src/api/forecast.ts': "export async function getForecast(city: string) {\n  const res = await fetch(`/api/forecast?city=${encodeURIComponent(city)}`)\n  if (!res.ok) throw new Error('Forecast request failed')\n  return res.json()\n}\n",
  })
  commit(0, 'Add CI workflow', { '.github/workflows/ci.yml': 'name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm test\n' })
  git('tag', '-a', 'v0.1.0', '-m', 'Aurora 0.1.0')
  git('push', '-q', '-u', 'origin', 'main', '--tags')

  // Feature: city search
  git('switch', '-q', '-c', 'feature/city-search')
  commit(2, 'Add city search input', { 'src/components/CitySearch.tsx': "export function CitySearch({ onSelect }: { onSelect: (city: string) => void }) {\n  return <input placeholder=\"Search a city…\" onChange={(e) => onSelect(e.target.value)} />\n}\n" })
  commit(2, 'Debounce city search requests', { 'src/hooks/useDebounce.ts': "import { useEffect, useState } from 'react'\n\nexport function useDebounce<T>(value: T, ms = 250) {\n  const [v, setV] = useState(value)\n  useEffect(() => {\n    const t = setTimeout(() => setV(value), ms)\n    return () => clearTimeout(t)\n  }, [value, ms])\n  return v\n}\n" })

  // Meanwhile on main
  git('switch', '-q', 'main')
  commit(1, 'Cache forecast responses for 10 minutes', { 'src/api/forecast.ts': '+\nconst cache = new Map<string, { at: number; data: unknown }>()\n' })

  // Feature: dark mode
  git('switch', '-q', '-c', 'feature/dark-mode')
  commit(3, 'Introduce theme tokens', { 'src/theme.css': ':root {\n  --bg: #ffffff;\n  --fg: #111827;\n}\n' })
  commit(3, 'Add dark theme and system preference detection', { 'src/theme.css': '+\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #0b1020;\n    --fg: #e5e7eb;\n  }\n}\n' })
  git('push', '-q', '-u', 'origin', 'feature/dark-mode')

  git('switch', '-q', 'feature/city-search')
  commit(2, 'Show recent searches', { 'src/components/RecentSearches.tsx': "export function RecentSearches({ items }: { items: string[] }) {\n  return <ul>{items.map((c) => <li key={c}>{c}</li>)}</ul>\n}\n" })

  git('switch', '-q', 'main')
  merge(0, 'feature/city-search', 'Merge branch feature/city-search')
  commit(4, 'Add hourly forecast chart', { 'src/components/HourlyChart.tsx': "export function HourlyChart({ temps }: { temps: number[] }) {\n  const max = Math.max(...temps)\n  return <svg viewBox=\"0 0 240 60\">{temps.map((t, i) => <rect key={i} x={i * 10} y={60 - (t / max) * 60} width={8} height={(t / max) * 60} />)}</svg>\n}\n" })
  commit(1, 'Fix timezone offset in sunrise times', { 'src/api/forecast.ts': '+\nexport const toLocal = (unix: number, offset: number) => new Date((unix + offset) * 1000)\n' }, 7)
  merge(0, 'feature/dark-mode', 'Merge branch feature/dark-mode')
  commit(0, 'Release 0.2.0', { 'package.json': '{\n  "name": "aurora",\n  "version": "0.2.0",\n  "private": true\n}\n', 'CHANGELOG.md': '# Changelog\n\n## 0.2.0\n- City search with recent searches\n- Dark mode\n- Hourly forecast chart\n' })
  git('tag', '-a', 'v0.2.0', '-m', 'Aurora 0.2.0')
  git('push', '-q', 'origin', 'main', '--tags')

  // Ongoing work
  git('switch', '-q', '-c', 'feature/offline-mode')
  commit(3, 'Register a service worker', { 'src/sw.ts': "self.addEventListener('install', () => self.skipWaiting())\n" })
  commit(3, 'Precache the app shell', { 'src/sw.ts': "+self.addEventListener('fetch', (event) => {\n  // serve cached shell when offline\n})\n" })

  git('switch', '-q', 'main')
  git('switch', '-q', '-c', 'fix/chart-overflow')
  commit(4, 'Clamp chart bars to the viewport', { 'src/components/HourlyChart.tsx': "export function HourlyChart({ temps }: { temps: number[] }) {\n  const max = Math.max(1, ...temps)\n  return <svg viewBox=\"0 0 240 60\" preserveAspectRatio=\"none\">{temps.map((t, i) => <rect key={i} x={i * 10} y={60 - Math.min(1, t / max) * 60} width={8} height={Math.min(1, t / max) * 60} />)}</svg>\n}\n" })
  git('push', '-q', '-u', 'origin', 'fix/chart-overflow')

  git('switch', '-q', 'main')
  commit(1, 'Retry forecast requests with backoff', { 'src/api/forecast.ts': '+\nexport async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {\n  try {\n    return await fn()\n  } catch (e) {\n    if (tries <= 1) throw e\n    await new Promise((r) => setTimeout(r, 2 ** (4 - tries) * 200))\n    return withRetry(fn, tries - 1)\n  }\n}\n' })
  commit(0, 'Document the forecast API', { 'README.md': '+\n## Forecast API\n\n`getForecast(city)` returns the 7 day forecast for a city.\n' })
  git('push', '-q', 'origin', 'main')

  // A stash with an experiment
  write('src/components/WeatherIcon.tsx', "export function WeatherIcon({ kind }: { kind: 'sun' | 'rain' }) {\n  return <span className={`icon icon-${kind}`} />\n}\n")
  git('stash', 'push', '--include-untracked', '-m', 'Experiment: animated weather icons')

  // Local, unpushed commit + working changes
  commit(2, 'Polish search empty state', { 'src/components/CitySearch.tsx': "export function CitySearch({ onSelect }: { onSelect: (city: string) => void }) {\n  return (\n    <label className=\"search\">\n      <span>City</span>\n      <input placeholder=\"Search a city…\" onChange={(e) => onSelect(e.target.value)} />\n    </label>\n  )\n}\n" })
  write('src/App.tsx', "import { CitySearch } from './components/CitySearch'\nimport { HourlyChart } from './components/HourlyChart'\n\nexport function App() {\n  return (\n    <main>\n      <h1>Aurora</h1>\n      <CitySearch onSelect={() => {}} />\n      <HourlyChart temps={[12, 14, 17, 19, 18, 15]} />\n    </main>\n  )\n}\n")
  write('src/components/WeeklyOutlook.tsx', "export function WeeklyOutlook() {\n  return <section aria-label=\"Weekly outlook\" />\n}\n")
  write('src/theme.css', ':root {\n  --bg: #ffffff;\n  --fg: #111827;\n  --accent: #3ee0f5;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #0b1020;\n    --fg: #e5e7eb;\n  }\n}\n')
  git('add', 'src/theme.css')

  return { root, dir, home, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
