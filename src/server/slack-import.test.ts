import { describe, expect, it, vi } from 'vitest'
import { slackImport } from './slack-import'
import { resolveAppRole } from 'deepspace/worker'
vi.mock('deepspace/worker', () => ({ resolveAppRole: vi.fn() }))
vi.mock('./extract', () => ({ loadChannelLead: async () => 'lead' }))

describe('Slack demo import', () => {
  function fixture() {
    const ts = '1795380000.000010'
    const rows = new Map<string, unknown>()
    const tools = {
      integration: vi.fn(async (endpoint: string) => ({
        success: true, data: endpoint.endsWith('list-channels') ? { channels: [{ id: 'C1', name: 'jams-test' }] } :
          { messages: [{ ts, user: 'U1', text: 'I will fix Safari.', user_profile: { display_name: 'Mahi Bhat' } },
            { ts, user: 'U2', subtype: 'channel_join', text: 'joined' }] },
      })),
      get: async (_: string, id: string) => rows.has(id) ? { success: true, data: { record: rows.get(id) } } : { success: false },
      create: async (_: string, data: unknown, id: string) => { rows.set(id, data); return { success: true } },
    }
    const run = (selected?: string[]) => slackImport({ env: { SLACK_BOT_TOKEN: 'fixture' }, userId: 'lead',
      params: { channelId: 'board', selected }, tools } as unknown as Parameters<typeof slackImport>[0])
    return { ts, rows, run, tools }
  }
  it('previews, keeps the original author, and skips an already imported message', async () => {
    vi.mocked(resolveAppRole).mockResolvedValue('admin')
    const { ts, rows, run } = fixture()
    expect(await run()).toMatchObject({ data: { messages: [{ ts, author: 'Mahi Bhat' }] } })
    expect(rows.size).toBe(0)
    expect(await run([ts])).toMatchObject({ data: { added: 1, skipped: 0 } })
    expect(await run([ts])).toMatchObject({ data: { added: 0, skipped: 1 } })
    expect([...rows.values()][0]).toMatchObject({ author: 'Mahi Bhat', slackUser: 'U1' })
  })
  it('handles wrapped integration data', async () => {
    vi.mocked(resolveAppRole).mockResolvedValue('admin')
    const { run, tools } = fixture()
    const original = tools.integration.getMockImplementation()!
    tools.integration.mockImplementation(async endpoint => {
      const reply = await original(endpoint)
      return { ...reply, data: { data: reply.data } } as unknown as typeof reply
    })
    expect(await run()).toMatchObject({ success: true })
  })
  it('reports which call failed without returning raw provider text', async () => {
    vi.mocked(resolveAppRole).mockResolvedValue('admin')
    const { run, tools } = fixture()
    const original = tools.integration.getMockImplementation()!
    tools.integration.mockImplementation(async endpoint => {
      const reply = await original(endpoint)
      if (endpoint.endsWith('list-channels')) return reply
      return { success: false, error: 'missing_scope: private diagnostic' } as unknown as typeof reply
    })
    expect(await run()).toEqual({ success: false, error: 'Slack channel-history: missing_scope' })
  })
  it('refuses member access before contacting Slack', async () => {
    vi.mocked(resolveAppRole).mockResolvedValue('member')
    const { run, tools } = fixture()
    expect(await run()).toMatchObject({ success: false })
    expect(tools.integration).not.toHaveBeenCalled()
  })
})
