/**
 * Tickets: the only collection JAMS adds.
 *
 * Every channel has a lead: the person who created it. Each ticket stores
 * that lead in `leadId`, which is the schema's ownerField, so the platform's
 * `'own'` rule lets exactly the lead (plus app admins) approve, edit, move or
 * dismiss. No UI or action code enforces this; the RecordRoom does.
 *
 * Nobody creates tickets from the client. The scanChat server action writes
 * proposals after checking the caller itself (actions run with RBAC off).
 */

import type { CollectionSchema } from 'deepspace/schema'

export const TICKET_STATUSES = ['proposed', 'todo', 'doing', 'done', 'dismissed'] as const
export const TICKET_BASES = ['commitment', 'request', 'suggestion'] as const

export const ticketsSchema: CollectionSchema = {
  name: 'tickets',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    { name: 'description', storage: 'text', interpretation: 'plain' },
    // Display name of the owner, '' when nobody has taken it.
    { name: 'assignee', storage: 'text', interpretation: 'plain' },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: [...TICKET_STATUSES] },
      required: true,
    },
    // Why the AI thinks this is work: someone committed, was asked, or suggested.
    {
      name: 'basis',
      storage: 'text',
      interpretation: { kind: 'select', options: [...TICKET_BASES] },
    },
    // Evidence[]: the chat messages that support this ticket.
    { name: 'evidence', storage: 'text', interpretation: { kind: 'json' } },
    // PendingChange | null: an AI-detected change to an already approved ticket,
    // waiting for the lead to accept or ignore.
    { name: 'pendingChange', storage: 'text', interpretation: { kind: 'json' } },
    // One line describing the most recent AI change, shown on the card.
    { name: 'lastChange', storage: 'text', interpretation: 'plain' },
    { name: 'channelId', storage: 'text', interpretation: 'plain', immutable: true },
    // User id of the channel's creator. Set by the server, never by a client.
    { name: 'leadId', storage: 'text', interpretation: 'plain', immutable: true },
  ],
  ownerField: 'leadId',
  permissions: {
    viewer: { read: true, create: false, update: false, delete: false },
    member: { read: true, create: false, update: 'own', delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
