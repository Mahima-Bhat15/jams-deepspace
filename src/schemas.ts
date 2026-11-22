/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * Add schemas by creating a file in src/schemas/ and importing it here.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'

import { messagingSchemas } from './schemas/messaging-schema'
import { ticketsSchema } from './schemas/tickets-schema'

export const schemas: CollectionSchema[] = [
  ...messagingSchemas,
  ticketsSchema,
  {
    name: 'slackMessages',
    columns: ['channelId', 'author', 'slackUser', 'content', 'postedAt'].map(name => ({
      name, storage: 'text', interpretation: 'plain', required: true, immutable: true,
    })),
    permissions: {
      viewer: { read: true, create: false, update: false, delete: false },
      member: { read: true, create: false, update: false, delete: false },
      admin: { read: true, create: false, update: false, delete: false },
    },
  },
  usersSchema,
  settingsSchema,
]
