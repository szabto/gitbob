import type { Page } from '@playwright/test'

/**
 * Sidebar sections other than Local start collapsed (docked at the bottom). Tests that work with
 * remotes, tags, stashes or worktrees expand them first, as a user would.
 */
export async function openAllSidebarSections(page: Page): Promise<void> {
  const sidebar = page.getByTestId('sidebar')
  try {
    await sidebar.waitFor({ timeout: 15_000 })
  } catch {
    return // no repository open (welcome screen)
  }
  for (const id of ['remote-branches', 'tags', 'stashes', 'worktrees']) {
    const header = sidebar.locator(`[data-testid="${id}"] > div > button[aria-expanded]`).first()
    try {
      await header.waitFor({ timeout: 5_000 })
    } catch {
      continue
    }
    if ((await header.getAttribute('aria-expanded')) === 'false') await header.click()
  }
}
