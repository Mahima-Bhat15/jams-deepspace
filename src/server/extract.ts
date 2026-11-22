/**
 * Server side of a scan: read chat + tickets, ask the model, validate.
 *
 * The model call goes through DeepSpace's AI proxy (createDeepSpaceAI), so
 * there is no provider API key anywhere in this repo. With no authToken the
 * proxy bills the app owner; see the README for why that tradeoff was chosen.
 */

import { generateObject } from 'ai'
import { createDeepSpaceAI } from 'deepspace/worker'
import {
  SYSTEM_PROMPT,
  buildTranscript,
  buildUserPrompt,
  normalizeTicket,
  planWrites,
  type ChatLine,
  type ExistingTicket,
  type Plan,
} from '../lib/jams.js'
import { extractionSchema } from './extraction-schema.js'
import type { Env } from '../../worker.js'

export const EXTRACTION_MODEL = 'claude-sonnet-5-5'
/** Most recent messages sent to the model per scan. Keeps cost and latency bounded. */
export const MAX_MESSAGES = 150

interface QueryResult {
  success?: boolean
  error?: string
  data?: { records?: Array<{ recordId: string; createdAt?: string; data: Record<string, unknown> }> }
}

/**
 * Query a collection in any RecordRoom with per-record RBAC off.
 * Callers MUST have authorized the user before calling this.
 */
export async function roomQuery(
  env: Env,
  room: string,
  userId: string,
  collection: string,
  options: Record<string, unknown> = {},
) {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(room))
  const res = await stub.fetch(
    new Request('https://internal/api/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId, 'X-App-Action': 'true' },
      body: JSON.stringify({ tool: 'records.query', params: { collection, ...options } }),
    }),
  )
  const json = (await res.json()) as QueryResult
  if (json.success === false) throw new Error(json.error ?? `query ${collection} failed`)
  return json.data?.records ?? []
}

/** Display names for every user in the app room, keyed by user id. */
export async function loadNames(env: Env, userId: string): Promise<Map<string, string>> {
  const rows = await roomQuery(env, `app:${env.DEEPSPACE_APP_ID}`, userId, 'users', { limit: 500 })
  const names = new Map<string, string>()
  for (const r of rows) {
    const d = r.data
    const name = String(d.name || d.email || 'Someone').trim()
    names.set(r.recordId, name)
  }
  return names
}

export async function loadChat(
  env: Env,
  userId: string,
  channelId: string,
  names: Map<string, string>,
): Promise<ChatLine[]> {
  // Messages live in the channel's own room (see the messaging feature).
  const rows = await roomQuery(env, `chat:${channelId}`, userId, 'messages', {
    where: { channelId },
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: MAX_MESSAGES,
  })
  const imports = await roomQuery(env, `app:${env.DEEPSPACE_APP_ID}`, userId, 'slackMessages', {
    where: { channelId }, orderBy: 'postedAt', orderDir: 'desc', limit: MAX_MESSAGES,
  })
  const imported = imports.map(r => ({ id: r.recordId, author: String(r.data.author),
    text: String(r.data.content), createdAt: String(r.data.postedAt) }))
  return rows
    .filter((r) => !r.data.deleted && !r.data.parentMessageId && String(r.data.content ?? '').trim())
    .map((r) => ({
      id: r.recordId,
      author: names.get(String(r.data.authorId)) ?? 'Someone',
      text: String(r.data.content),
      createdAt: String(r.createdAt ?? ''),
    }))
    .concat(imported)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_MESSAGES)
}

/** The channel's lead is whoever created it. Null if the channel does not exist. */
export async function loadChannelLead(env: Env, userId: string, channelId: string): Promise<string | null> {
  const rows = await roomQuery(env, `app:${env.DEEPSPACE_APP_ID}`, userId, 'channels', {
    where: { recordId: channelId },
    limit: 1,
  })
  const row = rows[0]
  if (!row || row.data.archived) return null
  return String(row.data.createdBy || (row as { createdBy?: string }).createdBy || '') || null
}

export async function loadTickets(env: Env, userId: string, channelId: string): Promise<ExistingTicket[]> {
  const rows = await roomQuery(env, `app:${env.DEEPSPACE_APP_ID}`, userId, 'tickets', {
    where: { channelId },
    limit: 500,
  })
  return rows.map((r) => ({ id: r.recordId, data: normalizeTicket(r.data) }))
}

/** Model call + validation. No writes happen here. */
export async function extract(
  env: Env,
  input: { lines: ChatLine[]; existing: ExistingTicket[]; channelId: string; leadId: string },
): Promise<Plan & { modelOps: number }> {
  const participants = [...new Set(input.lines.map((l) => l.author))]
  const { text, idMap } = buildTranscript(input.lines)
  const { prompt, ticketMap } = buildUserPrompt(text, participants, input.existing)

  const anthropic = createDeepSpaceAI(env, 'anthropic')
  const { object } = await generateObject({
    model: anthropic(EXTRACTION_MODEL),
    schema: extractionSchema,
    system: SYSTEM_PROMPT,
    prompt,
  })

  const plan = planWrites({
    ops: object.ops,
    idMap,
    ticketMap,
    participants,
    channelId: input.channelId,
    leadId: input.leadId,
  })
  return { ...plan, modelOps: object.ops.length }
}
