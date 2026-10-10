import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const app = await electron.launch({ executablePath: '/private/tmp/claude-501/-Users-szabto-Workspace-Personal-GitBob/355be40e-16fe-432d-aecf-7d17a7cc274a/scratchpad/rel/GitBob.app/Contents/MacOS/GitBob', args: [process.cwd()], env: { ...process.env, GITBOB_HIDDEN: '1', GITBOB_USER_DATA: mkdtempSync(join(tmpdir(), 'ud-')) } })
app.process().stderr?.on('data', (d) => process.stdout.write('[main] ' + d))
const page = await app.firstWindow()
page.on('console', (m) => console.log('[renderer]', m.type(), m.text().slice(0, 300)))
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)))
await page.waitForTimeout(6000)
console.log('URL', page.url())
console.log('TEXT', (await page.locator('body').innerText()).slice(0, 400))
await app.close()
