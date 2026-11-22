/**
 * Two-user JAMS flow: a message from one user appears live for the other,
 * a scan produces a proposal both of them see, and members get no approve
 * controls on a channel created by the other member.
 *
 * Needs two test accounts (see collab.spec.ts) and calls the real model, so
 * run it on purpose: npx deepspace test run all
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

const usable = loadAllTestAccounts().length
test.skip(usable < 2, `Needs 2 usable test accounts, found ${usable}.`)

test('chat syncs live and a scan proposes a ticket both users see', async ({ users }) => {
  test.setTimeout(150_000)
  const [a, b] = await users(2)
  await Promise.all([a.page.goto('/board'), b.page.goto('/board')])
  for (const u of [a, b]) {
    await expect(u.page.getByTestId('message-input')).toBeVisible({ timeout: 20_000 })
  }

  const tag = `E2E${Date.now().toString(36).toUpperCase()}`
  const channel = tag.toLowerCase()
  await a.page.getByRole('textbox', { name: 'New channel name' }).fill(channel)
  await a.page.getByRole('button', { name: 'Create', exact: true }).click()
  const select = b.page.getByTestId('channel-select')
  await expect(select.getByRole('option', { name: '#' + channel, exact: true })).toBeAttached()
  await select.selectOption({ label: '#' + channel })
  await expect(a.page.getByTestId('lead-line')).toContainText('You lead this channel')
  await expect(b.page.getByTestId('lead-line')).toContainText('approved by')
  const line = `I'll fix the ${tag} export bug today`
  await a.page.getByTestId('message-input').fill(line)
  await a.page.getByTestId('send-message-btn').click()

  // Realtime: B sees A's message without reloading.
  await expect(b.page.getByText(line)).toBeVisible({ timeout: 15_000 })

  // B scans; both see a proposal citing the message.
  await b.page.getByTestId('scan-button').click()
  for (const u of [a, b]) {
    const card = u.page.getByTestId('proposal-card').filter({ hasText: tag })
    await expect(card.first()).toBeVisible({ timeout: 90_000 })
  }

  // B is a member while A created this channel.
  const bCard = b.page.getByTestId('proposal-card').filter({ hasText: tag }).first()
  await expect(bCard.getByRole('button', { name: /approve/i })).toHaveCount(0)
  const aCard = a.page.getByTestId('proposal-card').filter({ hasText: tag }).first()
  const title = await aCard.getByRole('textbox', { name: 'Title' }).inputValue()
  await aCard.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(bCard).toHaveCount(0)
  await expect(b.page.getByText(title, { exact: true }).first()).toBeVisible()
})
