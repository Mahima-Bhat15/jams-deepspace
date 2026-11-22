import { resolveAppRole, type ActionHandler, type ActionTools } from 'deepspace/worker'
import { z } from 'zod'
import type { Env } from '../../worker'
import { loadChannelLead } from './extract'

const historyMessage = z.object({
  ts: z.string().regex(/^\d{10,}\.\d{6}$/),
  user: z.string().min(1), text: z.string().trim().min(1),
  subtype: z.string().optional(), bot_id: z.string().optional(),
  user_profile: z.object({ display_name: z.string().optional(), real_name: z.string().optional() }).optional(),
})

export function slackLines(messages: unknown[]) {
  return messages.flatMap(raw => {
    const parsed = historyMessage.safeParse(raw)
    if (!parsed.success) return []
    const m = parsed.data
    if (m.subtype || m.bot_id) return []
    return [{ ts: m.ts, userId: m.user, author: m.user_profile?.display_name || m.user_profile?.real_name || m.user, text: m.text }]
  }).sort((a, b) => a.ts.localeCompare(b.ts))
}

const channelList = z.object({
  channels: z.array(z.object({ id: z.string(), name: z.string(), is_archived: z.boolean().optional() })),
})
const history = z.object({ messages: z.array(z.unknown()) })

class SlackReadError extends Error {}

const knownErrors = [
  'invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'missing_scope',
  'not_in_channel', 'channel_not_found', 'insufficient_credits', 'rate_limited',
  'ratelimited', 'unauthorized', 'internal_error', 'invalid_arguments',
]

function knownError(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const result = value as Record<string, unknown>
  const summary = [result.code, result.error, result.message].filter(x => typeof x === 'string').join(' ').toLowerCase()
  return knownErrors.find(code => summary.includes(code))
}

async function readSlack<T>(tools: ActionTools, endpoint: string, input: object, schema: z.ZodType<T>) {
  const stage = 'Slack ' + endpoint
  let response
  try {
    response = await tools.integration('slack/' + endpoint, input)
  } catch {
    throw new SlackReadError(stage + ': integration request did not complete.')
  }
  const code = knownError(response)
  if (!response.success) throw new SlackReadError(stage + ': ' + (code ?? 'DeepSpace rejected the request.'))
  let body: unknown = response.data
  for (let level = 0; level < 3; level++) {
    const failure = knownError(body)
    if (failure) throw new SlackReadError(stage + ': ' + failure)
    const parsed = schema.safeParse(body)
    if (parsed.success) return parsed.data
    if (!body || typeof body !== 'object' || !('data' in body)) break
    body = body.data
  }
  throw new SlackReadError(stage + ': unexpected response format from the integration.')
}

export const slackImport: ActionHandler<Env> = async ({ userId, env, params, tools }) => {
  if (await resolveAppRole(env, userId) !== 'admin') {
    return { success: false, error: 'Only an app admin can import from the connected Slack workspace.' }
  }
  const { channelId, selected } = params
  if (typeof channelId !== 'string' || !channelId || channelId.length > 100 ||
      !await loadChannelLead(env, userId, channelId)) return { success: false, error: 'Select a JAMS channel.' }
  if (!env.SLACK_BOT_TOKEN) return { success: false, error: 'Configure SLACK_BOT_TOKEN and restart or deploy.' }
  const selection = z.array(z.string()).min(1).max(20).optional().safeParse(selected)
  if (!selection.success) return { success: false, error: 'Select up to 20 messages.' }
  try {
    const accessToken = env.SLACK_BOT_TOKEN
    const list = await readSlack(tools, 'list-channels', { accessToken, types: 'public_channel', limit: 200 }, channelList)
    const channel = list.channels.find(c => c.name === 'jams-test' && !c.is_archived)
    if (!channel) return { success: false, error: 'Public #jams-test was not found in the demo workspace.' }
    const page = await readSlack(tools, 'channel-history', { accessToken, channel: channel.id, limit: 20 }, history)
    const messages = slackLines(page.messages)
    if (!selection.data) return { success: true, data: { messages } }
    const ids = new Set(selection.data)
    const chosen = messages.filter(m => ids.has(m.ts))
    if (chosen.length !== ids.size) return { success: false, error: 'The Slack history changed. Preview again.' }
    let added = 0
    for (const m of chosen) {
      const id = [channelId, channel.id, m.ts].join('_')
      const already = await tools.get('slackMessages', id)
      if (already.success && already.data.record) continue
      const write = await tools.create('slackMessages', { channelId, author: m.author, slackUser: m.userId,
        content: m.text, postedAt: new Date(Number(m.ts) * 1000).toISOString() }, id)
      if (write.success) added++
      else if (!(await tools.get('slackMessages', id)).success) {
        return { success: false, error: 'Some messages could not be saved. Retrying skips saved copies.' }
      }
    }
    return { success: true, data: { added, skipped: chosen.length - added } }
  } catch (error) {
    return { success: false, error: error instanceof SlackReadError ? error.message : 'JAMS could not save the Slack import. Retry and check the board.' }
  }
}
