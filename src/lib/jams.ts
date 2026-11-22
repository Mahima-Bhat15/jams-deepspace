/**
 * JAMS core logic. Pure functions only (no DeepSpace or network imports), so
 * the parts that decide what reaches the board are unit-tested offline.
 *
 * Flow: chat messages -> transcript with short ids (m1, m2, ...) -> model
 * returns ops -> planWrites() validates every op against real data and turns
 * the survivors into record writes. The model never writes directly.
 */

// ---------------------------------------------------------------------------
// Types shared by worker and UI
// ---------------------------------------------------------------------------

export type TicketStatus = 'proposed' | 'todo' | 'doing' | 'done' | 'dismissed'
export type TicketBasis = 'commitment' | 'request' | 'suggestion'

export interface Evidence {
  messageId: string
  author: string
  text: string
}

export interface PendingChange {
  assignee?: string
  title?: string
  status?: 'dismissed'
  reason: string
  evidence: Evidence[]
}

export interface Ticket {
  title: string
  description: string
  assignee: string
  status: TicketStatus
  basis: TicketBasis
  evidence: Evidence[]
  pendingChange: PendingChange | null
  lastChange: string
  channelId: string
  leadId: string
}

export interface ChatLine {
  /** Real record id of the message. */
  id: string
  author: string
  text: string
  createdAt: string
}

export interface ExistingTicket {
  id: string
  data: Ticket
}

// ---------------------------------------------------------------------------
// Model output contract (the zod schema lives in src/server/extraction-schema.ts
// so the browser bundle does not ship zod)
// ---------------------------------------------------------------------------

export interface Op {
  type: 'create' | 'update'
  ticketId: string
  title: string
  description: string
  assignee: string
  assigneeChanged: boolean
  dismiss: boolean
  basis: TicketBasis
  reason: string
  evidence: string[]
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You turn a team chat into work tickets for a lead to review.

Rules:
1. A ticket is a concrete piece of work. Ignore greetings, opinions, status chatter and questions with no task.
2. Set basis:
   - commitment: a person clearly takes the work ("I'll do it", "on it", "I can take that").
   - request: someone asks a specific person and that person has not refused.
   - suggestion: an idea nobody has taken yet ("we should...", "maybe someone could..."). Assignee is "".
3. "Maybe I'll look at it" or "I might" is a suggestion, not a commitment.
4. If someone backs out later ("actually I can't", "drop me from that"), the ticket must reflect it:
   emit an update with assigneeChanged=true and assignee set to whoever took it over, or "" if nobody did.
5. If the work is cancelled ("never mind, we don't need X"), emit an update with dismiss=true.
6. Existing tickets are listed with ids t1, t2, ... Never create a duplicate of an existing ticket.
   Only emit an update if something actually changed since the ticket's evidence.
7. Every op must cite the message ids that support it. Cite the message that shows the current state.
8. Use participant names exactly as written. Never invent names.
9. If there is nothing to do, return {"ops": []}.`

export function buildTranscript(lines: ChatLine[]): {
  text: string
  idMap: Map<string, ChatLine>
} {
  const idMap = new Map<string, ChatLine>()
  const out: string[] = []
  lines.forEach((line, i) => {
    const shortId = `m${i + 1}`
    idMap.set(shortId, line)
    out.push(`[${shortId}] ${line.author}: ${line.text.replace(/\s+/g, ' ').trim()}`)
  })
  return { text: out.join('\n'), idMap }
}

export function buildUserPrompt(
  transcript: string,
  participants: string[],
  existing: ExistingTicket[],
): { prompt: string; ticketMap: Map<string, ExistingTicket> } {
  const ticketMap = new Map<string, ExistingTicket>()
  const live = existing.filter((t) => t.data.status !== 'dismissed')
  const ticketLines = live.map((t, i) => {
    const shortId = `t${i + 1}`
    ticketMap.set(shortId, t)
    const who = t.data.assignee || 'unassigned'
    return `[${shortId}] "${t.data.title}" owner=${who} status=${t.data.status} basis=${t.data.basis}`
  })
  const prompt = [
    `Participants: ${participants.join(', ') || '(unknown)'}`,
    '',
    'Existing tickets:',
    ticketLines.length ? ticketLines.join('\n') : '(none)',
    '',
    'Chat, oldest first:',
    transcript || '(empty)',
  ].join('\n')
  return { prompt, ticketMap }
}

// ---------------------------------------------------------------------------
// Validation: decide which ops become writes
// ---------------------------------------------------------------------------

export interface PlannedCreate {
  data: Ticket
}
export interface PlannedUpdate {
  ticketId: string
  patch: Partial<Ticket>
}
export interface Skipped {
  op: Op
  reason: string
}
export interface Plan {
  creates: PlannedCreate[]
  updates: PlannedUpdate[]
  skipped: Skipped[]
}

const MAX_QUOTE = 220

export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function matchParticipant(name: string, participants: string[]): string {
  const n = name.trim().toLowerCase()
  if (!n) return ''
  return participants.find((p) => p.toLowerCase() === n) ?? ''
}

function toEvidence(ids: string[], idMap: Map<string, ChatLine>): Evidence[] {
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const id of ids) {
    const line = idMap.get(id.trim())
    if (!line || seen.has(line.id)) continue
    seen.add(line.id)
    out.push({ messageId: line.id, author: line.author, text: line.text.slice(0, MAX_QUOTE) })
  }
  return out
}

function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const ids = new Set(a.map((e) => e.messageId))
  return [...a, ...b.filter((e) => !ids.has(e.messageId))]
}

export function planWrites(input: {
  ops: Op[]
  idMap: Map<string, ChatLine>
  ticketMap: Map<string, ExistingTicket>
  participants: string[]
  channelId: string
  leadId: string
}): Plan {
  const { ops, idMap, ticketMap, participants, channelId, leadId } = input
  const plan: Plan = { creates: [], updates: [], skipped: [] }
  const live = [...ticketMap.values()]
  const usedEvidence = new Set(live.flatMap((t) => t.data.evidence.map((e) => e.messageId)))
  const usedTitles = new Set(live.map((t) => normalizeTitle(t.data.title)))
  const touched = new Set<string>()

  for (const op of ops) {
    const evidence = toEvidence(op.evidence, idMap)
    if (evidence.length === 0) {
      plan.skipped.push({ op, reason: 'no valid message evidence' })
      continue
    }

    if (op.type === 'create') {
      const title = op.title.trim()
      if (!title) {
        plan.skipped.push({ op, reason: 'empty title' })
        continue
      }
      if (usedTitles.has(normalizeTitle(title))) {
        plan.skipped.push({ op, reason: 'duplicate title' })
        continue
      }
      if (evidence.every((e) => usedEvidence.has(e.messageId))) {
        plan.skipped.push({ op, reason: 'evidence already covered by another ticket' })
        continue
      }
      const assignee = op.basis === 'suggestion' ? '' : matchParticipant(op.assignee, participants)
      plan.creates.push({
        data: {
          title,
          description: op.description.trim(),
          assignee,
          status: 'proposed',
          basis: op.basis,
          evidence,
          pendingChange: null,
          lastChange: '',
          channelId,
          leadId,
        },
      })
      usedTitles.add(normalizeTitle(title))
      evidence.forEach((e) => usedEvidence.add(e.messageId))
      continue
    }

    // update
    const target = ticketMap.get(op.ticketId.trim())
    if (!target) {
      plan.skipped.push({ op, reason: `unknown ticket ${op.ticketId}` })
      continue
    }
    if (touched.has(target.id)) {
      plan.skipped.push({ op, reason: 'ticket already updated in this scan' })
      continue
    }
    const t = target.data
    const change: Omit<PendingChange, 'reason' | 'evidence'> = {}
    if (op.assigneeChanged) {
      const next = matchParticipant(op.assignee, participants)
      if (next !== t.assignee) change.assignee = next
    }
    const nextTitle = op.title.trim()
    if (nextTitle && normalizeTitle(nextTitle) !== normalizeTitle(t.title)) change.title = nextTitle
    if (op.dismiss) change.status = 'dismissed'

    if (Object.keys(change).length === 0) {
      plan.skipped.push({ op, reason: 'no actual change' })
      continue
    }
    const newEvidence = evidence.filter((e) => !t.evidence.some((x) => x.messageId === e.messageId))
    if (newEvidence.length === 0) {
      plan.skipped.push({ op, reason: 'change not backed by any new message' })
      continue
    }

    const reason = op.reason.trim() || 'Updated from chat'
    touched.add(target.id)
    if (t.status === 'proposed') {
      // Still a proposal: apply in place, the lead reviews it anyway.
      plan.updates.push({
        ticketId: target.id,
        patch: {
          ...(change.assignee !== undefined ? { assignee: change.assignee } : {}),
          ...(change.title ? { title: change.title } : {}),
          ...(change.status ? { status: change.status } : {}),
          evidence: mergeEvidence(t.evidence, newEvidence),
          lastChange: reason,
        },
      })
    } else {
      // Approved work never changes silently: park it for the lead.
      plan.updates.push({
        ticketId: target.id,
        patch: { pendingChange: { ...change, reason, evidence: newEvidence } },
      })
    }
  }
  return plan
}

/** Apply a pending change to an approved ticket (lead clicked Accept). */
export function acceptPendingChange(t: Ticket): Partial<Ticket> {
  const p = t.pendingChange
  if (!p) return {}
  return {
    ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
    ...(p.title ? { title: p.title } : {}),
    ...(p.status ? { status: p.status } : {}),
    evidence: mergeEvidence(t.evidence, p.evidence),
    lastChange: p.reason,
    pendingChange: null,
  }
}

/** JSON columns may arrive parsed or as strings depending on the path. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

export function normalizeTicket(raw: Record<string, unknown>): Ticket {
  return {
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    assignee: String(raw.assignee ?? ''),
    status: (raw.status as TicketStatus) ?? 'proposed',
    basis: (raw.basis as TicketBasis) ?? 'suggestion',
    evidence: parseJson<Evidence[]>(raw.evidence, []),
    pendingChange: parseJson<PendingChange | null>(raw.pendingChange, null),
    lastChange: String(raw.lastChange ?? ''),
    channelId: String(raw.channelId ?? ''),
    leadId: String(raw.leadId ?? ''),
  }
}
