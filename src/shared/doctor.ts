import { z } from 'zod'

export const doctorCheckSchema = z.object({
  key: z.enum(['cli', 'version', 'auth', 'config']),
  title: z.string().min(1).max(128),
  detail: z.string().min(1).max(2_000),
  status: z.enum(['ok', 'warning', 'failed', 'info'])
}).strict()

export const grokDoctorReportSchema = z.object({
  healthy: z.boolean(),
  remediation: z.enum(['choose-cli', 'run-grok-login']).optional(),
  checks: z.array(doctorCheckSchema).length(4)
}).strict()

export type DoctorCheck = z.infer<typeof doctorCheckSchema>
export type GrokDoctorReport = z.infer<typeof grokDoctorReportSchema>
