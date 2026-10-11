import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

export interface TerminalCommand {
  cmd: string
  args: string[]
}

/** Linux terminals tried in order, with the argument that sets the working directory (if any). */
const LINUX_TERMINALS: { cmd: string; cwdArgs: (dir: string) => string[] }[] = [
  { cmd: 'x-terminal-emulator', cwdArgs: () => [] },
  { cmd: 'gnome-terminal', cwdArgs: (d) => [`--working-directory=${d}`] },
  { cmd: 'konsole', cwdArgs: (d) => ['--workdir', d] },
  { cmd: 'xfce4-terminal', cwdArgs: (d) => [`--working-directory=${d}`] },
  { cmd: 'kitty', cwdArgs: (d) => ['--directory', d] },
  { cmd: 'alacritty', cwdArgs: (d) => ['--working-directory', d] },
  { cmd: 'xterm', cwdArgs: () => [] },
]

/**
 * How to open a terminal window in `dir` on this platform. Always an executable plus an argument
 * array (no shell string); the process also gets `dir` as its working directory.
 */
export function terminalCommand(platform: NodeJS.Platform, dir: string, available: (cmd: string) => boolean): TerminalCommand | null {
  if (platform === 'darwin') return { cmd: 'open', args: ['-a', 'Terminal', dir] }
  // `start` is a cmd builtin; the new window inherits the working directory.
  if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/d', '/c', 'start', '""', 'cmd.exe', '/k'] }
  for (const t of LINUX_TERMINALS) if (available(t.cmd)) return { cmd: t.cmd, args: t.cwdArgs(dir) }
  return null
}

async function onPath(cmd: string): Promise<boolean> {
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    try {
      await access(join(d, cmd))
      return true
    } catch {
      /* not here */
    }
  }
  return false
}

/** Open the platform's terminal in `dir`. Throws if no terminal could be found. */
export async function openTerminal(dir: string): Promise<void> {
  const found = new Set<string>()
  if (process.platform === 'linux') for (const t of LINUX_TERMINALS) if (await onPath(t.cmd)) found.add(t.cmd)
  const c = terminalCommand(process.platform, dir, (cmd) => found.has(cmd))
  if (!c) throw new Error('No terminal application was found. Install one (for example gnome-terminal or xterm).')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(c.cmd, c.args, { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
