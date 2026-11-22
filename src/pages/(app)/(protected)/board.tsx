/**
 * JAMS board: team chat on the left, AI proposals and the ticket board on the right.
 *
 * Writes here are plain RBAC-checked record writes. The tickets schema only
 * lets the channel lead (ownerField leadId) or an app admin update, so another
 * member's Approve would be refused by the room even if the button showed.
 */

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  RecordScope,
  getAuthToken,
  useChannels,
  useMutations,
  useQuery,
  useUser,
  useUsers,
  type Channel,
  type RecordData,
} from 'deepspace'
import { Check, Quote, ScanSearch, X } from 'lucide-react'
import { Badge, Button, Input, useToast } from '@/components/ui'
import { KanbanBoard, type KanbanItem } from '@/components/kanban/Kanban'
import { ChatHeader } from '@/components/messaging/chat/ChatHeader'
import { MessageList } from '@/components/messaging/chat/MessageList'
import { useChatChannel } from '@/components/messaging/hooks/useChatChannel'
import { messagingSchemas } from '@/schemas/messaging-schema'
import { acceptPendingChange, normalizeTicket, type Evidence, type Ticket } from '@/lib/jams'

interface Row {
  id: string
  t: Ticket
}

const COLUMNS = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'In progress' },
  { id: 'done', title: 'Done' },
]

export default function BoardPage() {
  // Makes sure a default "general" channel exists, as the messaging feature does.
  const { channelId: generalId, status } = useChatChannel('general')
  const { channels } = useChannels()
  const [params, setParams] = useSearchParams()
  const selected = params.get('c')
  const channel =
    channels.find((c) => c.recordId === selected && !c.data.archived) ??
    channels.find((c) => c.recordId === generalId)

  if (status !== 'ready' || !channel) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {status === 'ready' ? 'No channel yet. A member needs to open the app once.' : 'Loading…'}
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(320px,400px)_1fr]">
      <section className="flex min-h-0 flex-col border-r border-border" data-testid="chat-pane">
        <ChannelBar
          channels={channels.filter((c) => !c.data.archived)}
          currentId={channel.recordId}
          onSelect={(id) => setParams({ c: id })}
        />
        <ChatHeader channelId={channel.recordId} />
        <RecordScope key={channel.recordId} roomId={`chat:${channel.recordId}`} schemas={messagingSchemas}>
          <MessageList channelId={channel.recordId} />
        </RecordScope>
      </section>
      <TicketsPane
        key={channel.recordId}
        channelId={channel.recordId}
        channelName={channel.data.name}
        leadId={channel.data.createdBy || channel.createdBy}
      />
    </div>
  )
}

/** Pick a channel or start a new one. Whoever creates a channel is its lead. */
function ChannelBar({
  channels,
  currentId,
  onSelect,
}: {
  channels: RecordData<Channel>[]
  currentId: string
  onSelect: (id: string) => void
}) {
  const { create } = useChannels()
  const { user } = useUser()
  const toast = useToast()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const canCreate = user?.role === 'member' || user?.role === 'admin'

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40)
    if (!clean) return
    setBusy(true)
    try {
      const id = await create({ name: clean, description: 'Team channel' })
      setName('')
      onSelect(id)
    } catch (err) {
      toast.error('Could not create channel', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <select
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        value={currentId}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="Channel"
        data-testid="channel-select"
      >
        {channels.map((c) => (
          <option key={c.recordId} value={c.recordId}>
            #{c.data.name}
          </option>
        ))}
      </select>
      {canCreate && (
        <form onSubmit={add} className="flex flex-1 gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new-team-channel"
            aria-label="New channel name"
            className="h-9"
          />
          <Button size="sm" type="submit" variant="outline" disabled={busy || !name.trim()}>
            Create
          </Button>
        </form>
      )}
    </div>
  )
}

function TicketsPane({
  channelId,
  channelName,
  leadId,
}: {
  channelId: string
  channelName: string
  leadId: string
}) {
  const { user } = useUser()
  const { users } = useUsers()
  // Mirrors the schema rule (ownerField leadId + update 'own', admins all).
  // The room enforces it; this only decides which controls to show.
  const isLead = !!user && (user.id === leadId || user.role === 'admin')
  const leadName = users.find((u) => u.id === leadId)?.name ?? 'the channel creator'
  const canScan = user?.role === 'admin' || user?.role === 'member'
  const toast = useToast()
  const [scanning, setScanning] = useState(false)

  const { records, status } = useQuery('tickets', { where: { channelId }, orderBy: 'createdAt' })
  const { put, ready } = useMutations<Ticket>('tickets')

  const rows: Row[] = useMemo(
    () => records.map((r) => ({ id: r.recordId, t: normalizeTicket(r.data as Record<string, unknown>) })),
    [records],
  )
  const proposed = rows.filter((r) => r.t.status === 'proposed')
  const pending = rows.filter((r) => r.t.pendingChange && r.t.status !== 'proposed')
  const boardItems: (KanbanItem & { row: Row })[] = rows
    .filter((r) => ['todo', 'doing', 'done'].includes(r.t.status))
    .map((r) => ({ id: r.id, title: r.t.title, columnId: r.t.status, row: r }))

  async function scan() {
    setScanning(true)
    try {
      const res = await fetch('/api/actions/scanChat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await getAuthToken()}`,
        },
        body: JSON.stringify({ channelId }),
      })
      const body = (await res.json()) as {
        success: boolean
        error?: string
        data?: { created: number; updated: number; skipped: unknown[] }
      }
      if (!body.success || !body.data) {
        toast.error('Scan failed', body.error ?? `HTTP ${res.status}`)
        return
      }
      const { created, updated, skipped } = body.data
      if (created + updated === 0) toast.info('Nothing new', `${skipped.length} candidate(s) filtered out`)
      else toast.success('Scan done', `${created} new, ${updated} updated, ${skipped.length} filtered out`)
    } catch (e) {
      toast.error('Scan failed', e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-col overflow-y-auto" data-testid="tickets-pane">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <h1 className="text-base font-semibold text-foreground">Tickets from #{channelName}</h1>
          <p className="text-xs text-muted-foreground" data-testid="lead-line">
            {isLead
              ? 'You lead this channel: approve, edit, or dismiss proposals.'
              : `Proposals here are approved by ${leadName}. Create your own channel to lead one.`}
          </p>
        </div>
        <Button onClick={scan} loading={scanning} disabled={!canScan || scanning} data-testid="scan-button">
          <ScanSearch /> Scan chat
        </Button>
      </header>

      <div className="space-y-6 p-5">
        {pending.length > 0 && (
          <Block title="Changes to approved work" count={pending.length}>
            {pending.map((r) => (
              <PendingCard
                key={r.id}
                row={r}
                isLead={isLead}
                disabled={!ready}
                onAccept={() => put(r.id, acceptPendingChange(r.t))}
                onIgnore={() => put(r.id, { pendingChange: null })}
              />
            ))}
          </Block>
        )}

        <Block title="Proposed" count={proposed.length}>
          {status === 'loading' && <p className="text-sm text-muted-foreground">Loading…</p>}
          {status !== 'loading' && proposed.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No proposals. Talk in the chat, then press Scan chat.
            </p>
          )}
          {proposed.map((r) => (
            <ProposalCard
              // Remount when the AI changes the proposal so edit fields show it.
              key={`${r.id}:${r.t.title}:${r.t.assignee}`}
              row={r}
              isLead={isLead}
              disabled={!ready}
              onApprove={(patch) => put(r.id, { ...patch, status: 'todo' })}
              onDismiss={() => put(r.id, { status: 'dismissed' })}
            />
          ))}
        </Block>

        <Block title="Board" count={boardItems.length}>
          <KanbanBoard
            columns={COLUMNS}
            items={boardItems}
            onMoveItem={(id, col) => {
              if (!isLead) {
                toast.warning('Only the channel lead can move tickets')
                return
              }
              void put(id, { status: col as Ticket['status'] })
            }}
            renderItem={(item) => <BoardCard row={item.row} />}
          />
        </Block>
      </div>
    </section>
  )
}

function Block({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
        {title} <span className="text-xs text-muted-foreground">{count}</span>
      </h2>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function basisBadge(basis: Ticket['basis']) {
  const variant = basis === 'commitment' ? 'success' : basis === 'request' ? 'info' : 'outline'
  return (
    <Badge variant={variant} size="sm">
      {basis}
    </Badge>
  )
}

function EvidenceList({ items }: { items: Evidence[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {items.map((e) => (
        <li key={e.messageId} className="flex gap-2 text-xs text-muted-foreground">
          <Quote className="mt-0.5 size-3 shrink-0" />
          <span>
            <span className="font-medium text-foreground">{e.author}:</span> {e.text}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ProposalCard({
  row,
  isLead,
  disabled,
  onApprove,
  onDismiss,
}: {
  row: Row
  isLead: boolean
  disabled: boolean
  onApprove: (patch: Partial<Ticket>) => void
  onDismiss: () => void
}) {
  const { t } = row
  const [title, setTitle] = useState(t.title)
  const [assignee, setAssignee] = useState(t.assignee)
  const edited = title !== t.title || assignee !== t.assignee

  return (
    <article className="rounded-lg border border-border bg-card p-4" data-testid="proposal-card">
      <div className="flex flex-wrap items-center gap-2">
        {basisBadge(t.basis)}
        {t.lastChange && <span className="text-xs text-warning">Updated: {t.lastChange}</span>}
      </div>
      {isLead ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_180px]">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <Input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Unassigned"
            aria-label="Assignee"
          />
        </div>
      ) : (
        <>
          <h3 className="mt-2 text-sm font-medium text-foreground">{t.title}</h3>
          <p className="text-xs text-muted-foreground">Owner: {t.assignee || 'unassigned'}</p>
        </>
      )}
      {t.description && <p className="mt-2 text-sm text-muted-foreground">{t.description}</p>}
      <EvidenceList items={t.evidence} />
      {isLead && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={disabled || !title.trim()}
            onClick={() => onApprove(edited ? { title: title.trim(), assignee: assignee.trim() } : {})}
          >
            <Check /> {edited ? 'Save and approve' : 'Approve'}
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onDismiss}>
            <X /> Dismiss
          </Button>
        </div>
      )}
    </article>
  )
}

function PendingCard({
  row,
  isLead,
  disabled,
  onAccept,
  onIgnore,
}: {
  row: Row
  isLead: boolean
  disabled: boolean
  onAccept: () => void
  onIgnore: () => void
}) {
  const { t } = row
  const p = t.pendingChange!
  const lines: string[] = []
  if (p.assignee !== undefined) lines.push(`Owner: ${t.assignee || 'unassigned'} → ${p.assignee || 'unassigned'}`)
  if (p.title) lines.push(`Title: ${t.title} → ${p.title}`)
  if (p.status === 'dismissed') lines.push('Cancel this ticket')

  return (
    <article className="rounded-lg border border-warning/60 bg-warning/5 p-4" data-testid="pending-card">
      <h3 className="text-sm font-medium text-foreground">{t.title}</h3>
      <ul className="mt-1 text-sm text-foreground">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">{p.reason}</p>
      <EvidenceList items={p.evidence} />
      {isLead && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={disabled} onClick={onAccept}>
            <Check /> Accept change
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onIgnore}>
            Keep as is
          </Button>
        </div>
      )}
    </article>
  )
}

function BoardCard({ row }: { row: Row }) {
  const { t } = row
  return (
    <div>
      <p className="text-sm font-medium text-foreground">{t.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t.assignee || 'unassigned'}</p>
      {t.lastChange && <p className="mt-1 text-xs text-warning">{t.lastChange}</p>}
      {t.pendingChange && (
        <Badge variant="warning" size="sm" className="mt-1">
          change pending
        </Badge>
      )}
    </div>
  )
}
