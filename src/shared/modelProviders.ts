import { z } from 'zod'

export const modelApiBackendSchema = z.enum([
  'chat_completions',
  'responses',
  'messages'
])

export const providerEndpointClassSchema = z.enum(['loopback', 'lan', 'remote'])
export const providerCredentialStateSchema = z.enum(['none', 'environment', 'stored'])
export const providerConfigurationStatusSchema = z.enum(['configured', 'unavailable'])

export const publicModelProviderSummarySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  endpointClass: providerEndpointClassSchema,
  originRedacted: z.string().min(1).max(512),
  backend: modelApiBackendSchema,
  credentialState: providerCredentialStateSchema,
  isManagedCursor: z.boolean(),
  modelCount: z.number().int().nonnegative(),
  status: providerConfigurationStatusSchema
}).strict()

export const publicCustomModelSummarySchema = z.object({
  id: z.string().min(1).max(64),
  upstreamModel: z.string().min(1).max(256),
  name: z.string().min(1).max(100),
  providerId: z.string().min(1).max(64),
  backend: modelApiBackendSchema,
  contextWindow: z.number().int().positive(),
  supportsReasoningEffort: z.boolean(),
  isDefault: z.boolean()
}).strict()

export const publicCustomModelCatalogSchema = z.object({
  providers: z.array(publicModelProviderSummarySchema),
  models: z.array(publicCustomModelSummarySchema)
}).strict()

export type ModelApiBackend = z.infer<typeof modelApiBackendSchema>
export type ProviderEndpointClass = z.infer<typeof providerEndpointClassSchema>
export type ProviderCredentialState = z.infer<typeof providerCredentialStateSchema>
export type ProviderConfigurationStatus = z.infer<typeof providerConfigurationStatusSchema>
export type PublicModelProviderSummary = z.infer<typeof publicModelProviderSummarySchema>
export type PublicCustomModelSummary = z.infer<typeof publicCustomModelSummarySchema>
export type PublicCustomModelCatalog = z.infer<typeof publicCustomModelCatalogSchema>
