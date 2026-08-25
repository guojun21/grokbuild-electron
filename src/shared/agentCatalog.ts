import { z } from 'zod'

export const GROK_AGENT_CATALOG_LIMIT = 64
export const GROK_AGENT_VIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const GROK_AGENT_PUBLIC_NAME_MAX_CHARS = 256
export const GROK_AGENT_PUBLIC_DESCRIPTION_MAX_CHARS = 2_048
export const GROK_AGENT_PLUGIN_DISPLAY_NAME_MAX_CHARS = 256

export const grokAgentSourceKindSchema = z.enum([
  'builtin',
  'user',
  'project',
  'plugin'
])

export type GrokAgentSourceKind = z.infer<typeof grokAgentSourceKindSchema>

/**
 * Renderer-safe catalog record. The token is an opaque, short-lived view
 * capability; it is not the Grok agent selector and cannot be reconstructed
 * from it. Source paths and raw inspect records are intentionally absent.
 */
export const publicGrokAgentCatalogEntrySchema = z.object({
  token: z.string().regex(GROK_AGENT_VIEW_TOKEN_PATTERN),
  name: z.string().min(1).max(GROK_AGENT_PUBLIC_NAME_MAX_CHARS),
  description: z.string().max(GROK_AGENT_PUBLIC_DESCRIPTION_MAX_CHARS),
  sourceKind: grokAgentSourceKindSchema,
  pluginDisplayName: z.string().min(1).max(GROK_AGENT_PLUGIN_DISPLAY_NAME_MAX_CHARS).optional()
}).strict()

export type PublicGrokAgentCatalogEntry = z.infer<typeof publicGrokAgentCatalogEntrySchema>

export const publicGrokAgentCatalogSchema = z.array(publicGrokAgentCatalogEntrySchema)
  .min(1)
  .max(GROK_AGENT_CATALOG_LIMIT)

export type PublicGrokAgentCatalog = z.infer<typeof publicGrokAgentCatalogSchema>
