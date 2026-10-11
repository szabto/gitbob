import { describe, expect, it } from 'vitest'
import { terminalCommand } from '../../src/main/terminal'

describe('terminalCommand', () => {
  it('uses Terminal.app on macOS and cmd on Windows, with the folder as an argument or cwd', () => {
    expect(terminalCommand('darwin', '/a b/repo', () => false)).toEqual({ cmd: 'open', args: ['-a', 'Terminal', '/a b/repo'] })
    expect(terminalCommand('win32', 'C:\\a b\\repo', () => false)).toEqual({ cmd: 'cmd.exe', args: ['/d', '/c', 'start', '""', 'cmd.exe', '/k'] })
  })

  it('picks the first available Linux terminal and passes the folder safely', () => {
    expect(terminalCommand('linux', '/r', (c) => c === 'konsole' || c === 'xterm')).toEqual({ cmd: 'konsole', args: ['--workdir', '/r'] })
    expect(terminalCommand('linux', '/r;rm -rf ~', (c) => c === 'gnome-terminal')).toEqual({ cmd: 'gnome-terminal', args: ['--working-directory=/r;rm -rf ~'] })
    expect(terminalCommand('linux', '/r', () => false)).toBeNull()
  })
})
