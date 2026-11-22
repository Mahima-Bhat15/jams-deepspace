import { slackImport } from '../server/slack-import'
import type { ActionHandler } from 'deepspace/worker'
import { resolveAppRole } from 'deepspace/worker'
import type { Env } from '../../worker'
import { extract, loadChannelLead, loadChat, loadNames, loadTickets } from '../server/extract.js'

/**
 * scanChat: read the channel, propose tickets, write proposals.
 *
 * Actions run with record RBAC off, so this action authorizes the caller
 * itself: members and admins may scan, viewers and anonymous users may not.
 * It only ever writes `proposed` tickets or `pendingChange` on approved ones,
 * stamped with the channel creator as `leadId`. Approving is a normal
 * RBAC-checked client write that only that lead (or an app admin) can make.
 */
async function scanChat({ userId, params, tools, env }: Parameters<ActionHandler<Env>>[0]) {
  if (userId.startsWith('anon-')) return { success: false as const, error: 'Sign in to scan.' }
  const role = await resolveAppRole(env, userId)
  if (role !== 'member' && role !== 'admin') {
    return { success: false as const, error: 'Only team members can scan the chat.' }
  }
  const channelId = typeof params.channelId === 'string' ? params.channelId.trim() : ''
  if (!channelId || channelId.length > 100) {
    return { success: false as const, error: 'channelId is required.' }
  }

  const leadId = await loadChannelLead(env, userId, channelId)
  if (!leadId) return { success: false as const, error: 'Channel not found.' }

  const names = await loadNames(env, userId)
  const [lines, existing] = await Promise.all([
    loadChat(env, userId, channelId, names),
    loadTickets(env, userId, channelId),
  ])
  if (lines.length === 0) {
    return { success: true as const, data: { created: 0, updated: 0, skipped: [], modelOps: 0 } }
  }

  const plan = await extract(env, { lines, existing, channelId, leadId })

  let created = 0
  let updated = 0
  for (const c of plan.creates) {
    const res = await tools.create('tickets', { ...c.data })
    if (res.success) created++
    else console.error(`[scanChat] create failed: ${res.error}`)
  }
  for (const u of plan.updates) {
    const res = await tools.update('tickets', u.ticketId, { ...u.patch })
    if (res.success) updated++
    else console.error(`[scanChat] update ${u.ticketId} failed: ${res.error}`)
  }

  if (created !== plan.creates.length || updated !== plan.updates.length) {
    return {
      success: false as const,
      error: `Saved ${created} new and ${updated} updated tickets. Some changes could not be saved. Review the board before scanning again.`,
    }
  }
  console.info(
    `[scanChat] channel=${channelId} messages=${lines.length} modelOps=${plan.modelOps} ` +
      `created=${plan.creates.length} updated=${plan.updates.length} skipped=${plan.skipped.length}`,
  )
  return {
    success: true as const,
    data: {
      created: plan.creates.length,
      updated: plan.updates.length,
      modelOps: plan.modelOps,
      skipped: plan.skipped.map((s) => ({ title: s.op.title || s.op.ticketId, reason: s.reason })),
    },
  }
}

export const actions: Record<string, ActionHandler<Env>> = {
  slackImport,
  scanChat: async (ctx) => {
    try {
      return await scanChat(ctx)
    } catch (err) {
      console.error(`[scanChat] ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: 'Scan failed. Try again in a moment.' }
    }
  },
}
