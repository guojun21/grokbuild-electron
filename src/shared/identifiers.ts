import { z } from 'zod'

export const strictUuidSchema = z.string().uuid()

export function isStrictUuid(value: string | undefined): value is string {
  return strictUuidSchema.safeParse(value).success
}
