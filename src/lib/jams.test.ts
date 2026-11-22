import { describe, expect, it } from 'vitest'
import {
  acceptPendingChange,
  buildTranscript,
  buildUserPrompt,
  normalizeTicket,
  planWrites,
  type ChatLine,
  type ExistingTicket,
  type Op,
  type Ticket,
} from './jams'

const chat: ChatLine[] = [
  { id: 'r1', author: 'Alice', text: "I'll fix the login bug today", createdAt: '1' },
  { id: 'r2', author: 'Bob', text: 'we should probably add rate limiting at some point', createdAt: '2' },
  { id: 'r3', author: 'Alice', text: "actually I can't this week, Bob can you take login?", createdAt: '3' },
  { id: 'r4', author: 'Bob', text: 'sure, on it', createdAt: '4' },
]
const participants = ['Alice', 'Bob']

function op(partial: Partial<Op>): Op {
  return {
    type: 'create',
    ticketId: '',
    title: '',
    description: '',
    assignee: '',
    assigneeChanged: false,
    dismiss: false,
    basis: 'commitment',
    reason: '',
    evidence: [],
    ...partial,
  }
}

function ticket(partial: Partial<Ticket>): Ticket {
  return {
    title: 'Fix login bug',
    description: '',
    assignee: 'Alice',
    status: 'proposed',
    basis: 'commitment',
    evidence: [{ messageId: 'r1', author: 'Alice', text: "I'll fix the login bug today" }],
    pendingChange: null,
    lastChange: '',
    channelId: 'c1',
    leadId: 'u-lead',
    ...partial,
  }
}

function setup(existing: ExistingTicket[] = []) {
  const { text, idMap } = buildTranscript(chat)
  const { prompt, ticketMap } = buildUserPrompt(text, participants, existing)
  return { text, idMap, prompt, ticketMap }
}

describe('transcript and prompt', () => {
  it('numbers messages with short ids and lists existing tickets', () => {
    const { text, prompt } = setup([{ id: 'x1', data: ticket({}) }])
    expect(text.split('\n')[0]).toBe("[m1] Alice: I'll fix the login bug today")
    expect(prompt).toContain('[t1] "Fix login bug" owner=Alice status=proposed')
    expect(prompt).toContain('Participants: Alice, Bob')
  })

  it('hides dismissed tickets from the model', () => {
    const { prompt } = setup([{ id: 'x1', data: ticket({ status: 'dismissed' }) }])
    expect(prompt).toContain('Existing tickets:\n(none)')
  })
})

describe('planWrites: creates', () => {
  it('creates a proposed ticket with real message ids as evidence', () => {
    const { idMap, ticketMap } = setup()
    const plan = planWrites({
      ops: [op({ title: 'Fix login bug', assignee: 'bob', evidence: ['m1', 'm3', 'm4'] })],
      idMap,
      ticketMap,
      participants,
      channelId: 'c1',
      leadId: 'u-lead',
    })
    expect(plan.creates).toHaveLength(1)
    const t = plan.creates[0].data
    expect(t.status).toBe('proposed')
    expect(t.leadId).toBe('u-lead') // ownerField: only the channel lead may approve
    expect(t.assignee).toBe('Bob') // case-normalized to the real participant name
    expect(t.evidence.map((e) => e.messageId)).toEqual(['r1', 'r3', 'r4'])
  })

  it('drops ops whose evidence ids do not exist (hallucinated citations)', () => {
    const { idMap, ticketMap } = setup()
    const plan = planWrites({
      ops: [op({ title: 'Ghost task', evidence: ['m99'] })],
      idMap,
      ticketMap,
      participants,
      channelId: 'c1',
      leadId: 'u-lead',
    })
    expect(plan.creates).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe('no valid message evidence')
  })

  it('never assigns an invented person', () => {
    const { idMap, ticketMap } = setup()
    const plan = planWrites({
      ops: [op({ title: 'Fix login bug', assignee: 'Carol', evidence: ['m1'] })],
      idMap,
      ticketMap,
      participants,
      channelId: 'c1',
      leadId: 'u-lead',
    })
    expect(plan.creates[0].data.assignee).toBe('')
  })

  it('keeps suggestions unassigned', () => {
    const { idMap, ticketMap } = setup()
    const plan = planWrites({
      ops: [op({ title: 'Add rate limiting', basis: 'suggestion', assignee: 'Bob', evidence: ['m2'] })],
      idMap,
      ticketMap,
      participants,
      channelId: 'c1',
      leadId: 'u-lead',
    })
    expect(plan.creates[0].data.assignee).toBe('')
    expect(plan.creates[0].data.basis).toBe('suggestion')
  })

  it('skips duplicates by title and by already used evidence', () => {
    const existing = [{ id: 'x1', data: ticket({}) }]
    const { idMap, ticketMap } = setup(existing)
    const plan = planWrites({
      ops: [
        op({ title: 'fix the login bug!!', evidence: ['m4'] }),
        op({ title: 'Fix login bug', evidence: ['m4'] }),
        op({ title: 'Login fix', evidence: ['m1'] }),
      ],
      idMap,
      ticketMap,
      participants,
      channelId: 'c1',
      leadId: 'u-lead',
    })
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'duplicate title',
      'evidence already covered by another ticket',
    ])
    // "fix the login bug" is a different normalized title with new evidence, so it is allowed.
    expect(plan.creates).toHaveLength(1)
  })
})

describe('planWrites: retractions and updates', () => {
  it('updates a proposal in place when the owner backs out', () => {
    const existing = [{ id: 'x1', data: ticket({}) }]
    const { idMap, ticketMap } = setup(existing)
    const plan = planWrites({
      ops: [
        op({
          type: 'update',
          ticketId: 't1',
          assignee: 'Bob',
          assigneeChanged: true,
          reason: 'Alice backed out, Bob took it',
          evidence: ['m3', 'm4'],
        }),
      ],
      idMap,
      ticketMap,
      participants,
      channelId: 'c1',
      leadId: 'u-lead',
    })
    expect(plan.updates).toEqual([
      {
        ticketId: 'x1',
        patch: expect.objectContaining({ assignee: 'Bob', lastChange: 'Alice backed out, Bob took it' }),
      },
    ])
    const ev = plan.updates[0].patch.evidence!.map((e) => e.messageId)
    expect(ev).toEqual(['r1', 'r3', 'r4'])
  })

  it('parks the change for the lead when the ticket was already approved', () => {
    const existing = [{ id: 'x1', data: ticket({ status: 'doing' }) }]
    const { idMap, ticketMap } = setup(existing)
    const plan = planWrites({
      ops: [op({ type: 'update', ticketId: 't1', assignee: '', assigneeChanged: true, reason: 'Alice backed out', evidence: ['m3'] })],
      idMap,
      ticketMap,
      participants,
      channelId: 'c1',
      leadId: 'u-lead',
    })
    const patch = plan.updates[0].patch
    expect(patch.assignee).toBeUndefined() // approved work never changes silently
    expect(patch.pendingChange).toMatchObject({ assignee: '', reason: 'Alice backed out' })
  })

  it('ignores updates that change nothing or cite only old messages', () => {
    const existing = [{ id: 'x1', data: ticket({}) }]
    const { idMap, ticketMap } = setup(existing)
    const plan = planWrites({
      ops: [
        op({ type: 'update', ticketId: 't1', assignee: 'Alice', assigneeChanged: true, evidence: ['m3'] }),
        op({ type: 'update', ticketId: 't1', dismiss: true, evidence: ['m1'] }),
        op({ type: 'update', ticketId: 't9', dismiss: true, evidence: ['m3'] }),
      ],
      idMap,
      ticketMap,
      participants,
      channelId: 'c1',
      leadId: 'u-lead',
    })
    expect(plan.updates).toHaveLength(0)
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'no actual change',
      'change not backed by any new message',
      'unknown ticket t9',
    ])
  })

  it('accepting a pending change applies it and clears it', () => {
    const t = ticket({
      status: 'todo',
      pendingChange: {
        assignee: 'Bob',
        reason: 'Alice backed out',
        evidence: [{ messageId: 'r3', author: 'Alice', text: "can't" }],
      },
    })
    const patch = acceptPendingChange(t)
    expect(patch).toMatchObject({ assignee: 'Bob', pendingChange: null, lastChange: 'Alice backed out' })
    expect(patch.evidence!.map((e) => e.messageId)).toEqual(['r1', 'r3'])
  })
})

describe('normalizeTicket', () => {
  it('parses JSON columns that arrive as strings', () => {
    const t = normalizeTicket({
      title: 'x',
      status: 'todo',
      evidence: JSON.stringify([{ messageId: 'a', author: 'A', text: 't' }]),
      pendingChange: '',
    })
    expect(t.evidence).toHaveLength(1)
    expect(t.pendingChange).toBeNull()
  })
})
