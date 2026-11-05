import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function enterDemo(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Try demo mode' }).click()
  await expect(page.getByText('Demo mode', { exact: true })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Demo data set' })).toBeVisible()
}

async function selectFixture(page: Page, label: string) {
  const group = page.getByRole('radiogroup', { name: 'Demo data set' })
  await group.getByText(label, { exact: true }).click()
  await expect(group.getByRole('radio', { name: label })).toBeChecked()
}

test.describe('production Demo mode', () => {
  test('@smoke ships the complete dataset pill in the built app', async ({ page }) => {
    await enterDemo(page)

    const group = page.getByRole('radiogroup', { name: 'Demo data set' })
    await expect(group.getByRole('radio')).toHaveCount(6)
    for (const label of ['Demo board', 'Dev sample', 'Worst case', 'Empty', 'One', '400 cards']) {
      await expect(group.getByRole('radio', { name: label })).toBeVisible()
    }
    await expect(group.getByRole('radio', { name: 'Demo board' })).toBeChecked()
  })

  test('switches fixtures immediately and restores the selection after reload', async ({ page }) => {
    await enterDemo(page)

    await selectFixture(page, 'Worst case')
    await expect(page).toHaveURL(/[?&]data=worst(?:&|$)/)
    const worstCard = page.getByRole('button', { name: /Open PAYMENTSRV-104523:/ })
    await expect(worstCard).toHaveCount(1)
    await expect(worstCard).toBeVisible()

    await page.reload()
    await expect(page.getByRole('radio', { name: 'Worst case' })).toBeChecked()
    await expect(worstCard).toHaveCount(1)
    await expect(worstCard).toBeVisible()
  })

  test('supports native radio arrow keys', async ({ page }) => {
    await enterDemo(page)

    const demo = page.getByRole('radio', { name: 'Demo board' })
    await demo.focus()
    await page.keyboard.press('ArrowRight')

    await expect(page.getByRole('radio', { name: 'Dev sample' })).toBeChecked()
    await expect(page).toHaveURL(/[?&]data=demo(?:&|$)/)
  })

  test('Reset demo restores a fixture card without touching the real archive', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.setItem('jb-archived', JSON.stringify(['REAL-1'])))
    await page.getByRole('button', { name: 'Try demo mode' }).click()
    await selectFixture(page, 'Worst case')

    const doneCard = page.getByRole('button', { name: /Open PAYMENTSRV-103999:/ })
    await expect(doneCard).toBeVisible()
    await doneCard.getByRole('button', { name: 'Move to Completed' }).click()
    await expect(doneCard).toBeHidden()

    await page.getByRole('button', { name: 'Reset demo' }).click()
    await expect(doneCard).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('jb-archived'))).toBe(JSON.stringify(['REAL-1']))
  })

  test('leaving Demo mode hides the pill and ignores its stale fixture URL', async ({ page }) => {
    await enterDemo(page)
    await selectFixture(page, 'Worst case')

    await page.getByRole('button', { name: 'Show my real board' }).click()

    await expect(page.getByRole('radiogroup', { name: 'Demo data set' })).toBeHidden()
    await expect(page.getByRole('button', { name: /Open PAYMENTSRV-104523:/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Try demo mode' })).toBeVisible()
    await expect(page).toHaveURL(/[?&]data=worst(?:&|$)/)
  })

  test('loads the 400-card fixture and keeps the pill inside a laptop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await enterDemo(page)
    await selectFixture(page, '400 cards')

    await expect(page.getByRole('button', { name: 'All 400' })).toBeVisible()
    const box = await page.getByRole('radiogroup', { name: 'Demo data set' }).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1024)
    expect(box!.y + box!.height).toBeLessThanOrEqual(768)
  })

  test('keeps every dataset option reachable on a 320px mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await enterDemo(page)

    const group = page.getByRole('radiogroup', { name: 'Demo data set' })
    const last = group.getByText('400 cards', { exact: true })
    const groupBox = await group.boundingBox()
    expect(groupBox).not.toBeNull()
    expect(groupBox!.x).toBeGreaterThanOrEqual(0)
    expect(groupBox!.x + groupBox!.width).toBeLessThanOrEqual(320)

    await last.scrollIntoViewIfNeeded()
    await last.click()
    await expect(group.getByRole('radio', { name: '400 cards' })).toBeChecked()
    await expect(page).toHaveURL(/[?&]data=huge(?:&|$)/)
  })

  test('has no axe violations in the production dataset control', async ({ page }) => {
    await enterDemo(page)

    const results = await new AxeBuilder({ page }).include('[aria-label="Demo data set"]').analyze()

    expect(results.violations).toEqual([])
  })
})
