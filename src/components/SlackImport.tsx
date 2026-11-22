import { useState } from 'react'
import { getAuthToken, useQuery } from 'deepspace'
import { Button } from './ui'

type Message = { ts: string; author: string; text: string }
type ImportResult = { messages?: Message[]; added?: number; skipped?: number }

export function SlackImport({ channelId, admin }: { channelId: string; admin: boolean }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const { records } = useQuery<{ author: string; content: string }>('slackMessages', { where: { channelId }, orderBy: 'postedAt' })

  async function request(save: boolean) {
    setBusy(true)
    setNotice('')
    try {
      const res = await fetch('/api/actions/slackImport', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + await getAuthToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, selected: save ? selected : undefined }),
      })
      const body = await res.json() as { success: boolean; data?: ImportResult; error?: string }
      if (!res.ok || !body.success || !body.data) throw new Error(body.error || 'Import request failed.')
      if (save) {
        setNotice(`Imported ${body.data.added}; already saved: ${body.data.skipped}. Click Scan chat to review tickets.`)
        setMessages([])
      } else {
        const preview = body.data.messages ?? []
        setMessages(preview)
        setSelected([])
        setNotice(preview.length ? 'Select messages to share on this JAMS board.' : 'No recent user messages in #jams-test.')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Request failed.')
    } finally { setBusy(false) }
  }

  if (!admin && !records.length) return null
  return <section className="border-b border-border px-5 py-3 space-y-2">
    {admin && <Button variant="outline" disabled={busy} onClick={() => request(false)}>Preview Slack #jams-test</Button>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {messages.length > 0 && <fieldset disabled={busy} className="space-y-2">
      {messages.map(m => <label key={m.ts} className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={selected.includes(m.ts)} onChange={e =>
          setSelected(e.target.checked ? [...selected, m.ts] : selected.filter(id => id !== m.ts))}/>
        <span><strong>{m.author}</strong> {m.text}</span>
      </label>)}
      <Button disabled={!selected.length || busy} onClick={() => request(true)}>Import selected</Button>
    </fieldset>}
    {!!records.length && <details><summary>Imported Slack messages ({records.length})</summary>
      {records.map(r => <p key={r.recordId} className="text-sm"><strong>{String(r.data.author)}</strong> {String(r.data.content)}</p>)}
    </details>}
  </section>
}
