/**
 * Structured-output contract for the extractor. Server only.
 * Flat shape (no unions) so every provider's structured output accepts it.
 */

import { z } from 'zod/v4'
import type { Op } from '../lib/jams.js'

export const opSchema = z.object({
  type: z.enum(['create', 'update']),
  ticketId: z
    .string()
    .describe('For update only: the id of the existing ticket (t1, t2, ...). Empty for create.'),
  title: z.string().describe('Short imperative title. For update, empty unless the scope changed.'),
  description: z.string().describe('One sentence of context. Empty for update.'),
  assignee: z
    .string()
    .describe(
      'Exact participant name who owns it now, or "" if nobody. For update, "" plus assigneeChanged=true means the owner backed out with no replacement.',
    ),
  assigneeChanged: z.boolean().describe('For update: true if the owner changed. False for create.'),
  dismiss: z.boolean().describe('For update: true if the work was cancelled or is no longer needed.'),
  basis: z.enum(['commitment', 'request', 'suggestion']),
  reason: z.string().describe('For update: one short sentence explaining what changed and why.'),
  evidence: z.array(z.string()).describe('Message ids (m1, m2, ...) that support this op.'),
})

export const extractionSchema = z.object({ ops: z.array(opSchema) })
export type Extraction = z.infer<typeof extractionSchema>


// Compile-time check that the schema and the shared Op type never drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const _opTypeMatches: Same<z.infer<typeof opSchema>, Op> = true
