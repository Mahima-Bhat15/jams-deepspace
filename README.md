# JAMS: chat to tickets

Team chat that turns conversation into work tickets a lead can trust.

People talk normally in a channel. Anyone on the team presses **Scan chat**. JAMS proposes tickets, each one showing the exact messages that back it up. The channel lead approves, edits, or dismisses proposals, and approved tickets land on a live board everyone sees.

The interesting part is that conversations change their minds. If Alice says "I'll take the login bug" and later says "actually I can't, Bob can you?", the ticket follows: a proposal is updated in place, and an already approved ticket gets a **pending change** that the lead must accept. Approved work never changes silently.

Live: `https://<name>.app.space` · Try it: sign in, create your own channel (you become its lead), chat, scan, approve. Open a second browser with another account to see the member view update live.

## How it works

```
messages (channel room) ─┐
                         ├─► scanChat action ─► model (structured output) ─► planWrites() ─► tickets
tickets (app room) ──────┘        checks role          ops with m1/t1 ids        validation        proposed / pendingChange
```

1. `scanChat` (server action) checks the caller is a member or admin, loads the channel's messages, existing tickets, and the channel's creator (the lead).
2. Messages go to the model with short ids (`m1`, `m2`...), existing tickets as `t1`, `t2`.... The model returns `create` / `update` ops through a zod schema.
3. `planWrites()` (pure, unit tested) decides what is real: unknown message ids are dropped, invented names become "unassigned", duplicates are skipped, updates must cite a new message and change something. Proposals get edited in place; approved tickets get `pendingChange`.
4. Writes land in the `tickets` collection and sync to every open browser.

## DeepSpace integrations used

| Integration | Why it is here |
|---|---|
| **Messaging** (`deepspace add messaging`) | The chat is the product's input. Channels, threads, reactions and read receipts come from the platform, not my code. |
| **Real-time records** (`useQuery` / `useMutations`) | Proposals, pending changes and the board update live for everyone in the channel. |
| **RBAC with `ownerField`** | `tickets.leadId` is the ownerField and members get `update: 'own'`, so only the channel's creator (or an app admin) can approve. The RecordRoom enforces it; the UI only hides buttons. |
| **Server actions** | The scan needs RBAC-off reads across two rooms and writes the user cannot make directly. The action authorizes the caller itself with `resolveAppRole`. |
| **AI proxy** (`createDeepSpaceAI` + AI SDK `generateObject`) | Claude Sonnet 5.5 with structured output. No provider key exists anywhere in the repo. |
| **Agent tools** (`registerAgent`) | `jams_preview` is a dry run of the extractor, callable with `npx deepspace agent invoke`. The eval script uses it. The built-in assistant tools are trimmed to read-only. |
| **Kanban** (`deepspace add kanban`) | Board UI component. |

**Left out on purpose:** Stripe (nothing to sell in an evaluation), LiveKit and file uploads (the input is text chat), managed knowledge (the context is one channel, which fits in a prompt), cron (scanning on a timer would spend credits on idle channels and make proposals appear with nobody watching; a person pressing Scan is the right trigger at this scale).

## Slack demo import

An app admin can preview the 20 most recent entries in the public Slack channel
`#jams-test` and share selected user messages on a JAMS board. The worker calls
DeepSpace's `slack/list-channels` and `slack/channel-history` integrations with
a server-side `SLACK_BOT_TOKEN`. Install the demo bot with `channels:read`
and `channels:history`, invite it to that channel, set the secret, and deploy.
Regular members can scan the shared messages. Original timestamps and Slack
user IDs are stored. Display names are used when present in history; otherwise
the Slack ID identifies the author. Duplicate imports in one board use the
same record ID. The preview reads one page in the dedicated demo workspace.

## Main tradeoff

**The AI proposes, a human approves.** Full automation would be faster, but a wrong owner on a ticket is worse than a slow one. Every proposal cites its messages, and changes to approved work wait for the lead. The cost is one extra click per ticket.

Smaller tradeoffs:

* **Manual scan, not per message.** Cheaper and predictable. A scan re-reads the last 150 messages, and checks for previously proposed work. Concurrent scans can still race.
* **Owner-billed AI.** Reviewers can try it without credits. In a real product this would switch to user billing (`authToken: callerJwt`).
* **Whole-recent-window, not incremental.** Simpler and lets the model see a retraction next to the original commitment. It stops scaling past a few hundred messages per channel.

## Security notes

* No secrets in the repo. The model is reached through the DeepSpace proxy.
* Actions run with record RBAC off, so `scanChat` checks role, validates `channelId`, and only writes `proposed` tickets or `pendingChange`. It cannot approve anything.
* `leadId` and `channelId` are `immutable`, and nobody can create tickets from the client.
* Assistant and local-agent tools are read-only. `jams_preview` writes nothing.

## Verification

* `src/lib/jams.test.ts`: 12 unit tests for the validation layer (hallucinated message ids, invented assignees, duplicates, retraction on proposals vs approved tickets, accepting a pending change).
* `scripts/eval.mjs`: 8 fixture conversations (plain commitment, hand-off, back out with nobody replacing, suggestion, hedge, chit chat, cancelled work, two tasks at once) run against the deployed model. Results: `<fill in>`.
* `tests/jams.spec.ts`: two-user Playwright test. A's message appears for B live, B scans in a channel created by A, both see the proposal, only A sees Approve, and approval syncs to B. This test targets the local dev server.

## Run it

```bash
npm ci
npx deepspace auth login
npx deepspace app init --json
npx deepspace dev start          # local
npm run test:unit                # unit tests
# For GitHub source, commit and push to your intended GitHub origin first.
npx deepspace deploy             # first release permanently selects the source
node scripts/eval.mjs <app-name> # extraction eval against the deployed app
npx deepspace test run all       # includes the two-user test (needs 2 test accounts)
```

## What I would do next

* Click a quoted message to jump to it in the chat.
* Re-scan automatically after N new messages, with a per-channel lock so two scans cannot race.
* Incremental scans (only messages since the last scan plus open tickets) for long channels.
* Grow the eval set from real misses.
