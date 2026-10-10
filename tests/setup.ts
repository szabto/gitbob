import { afterAll } from 'vitest'
import { isolateProcessGitEnv } from './helpers/fixture'

// Code under test spawns git with process.env; keep the developer's global/system
// git config (signing, hooksPath, aliases, identity) out of every test file.
const restore = isolateProcessGitEnv()
afterAll(restore)
