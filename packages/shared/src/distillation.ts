import { z } from "zod";

export const DISTILLATION_JOB_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export const DISTILLATION_ITEM_STATUSES = [
  "pending",
  "processing",
  "learned",
  "skipped",
  "failed",
] as const;

export const DISTILLATION_PROPOSAL_STATUSES = [
  "draft",
  "validated",
  "validation_failed",
  "applied",
  "rejected",
] as const;

export const routingSignalAdjustmentSchema = z.object({
  type: z.enum(["weight_delta", "boundary_rule", "signal_confirm"]),
  taskType: z.enum([
    "vision",
    "debug",
    "code",
    "long_context",
    "writing",
    "general",
  ]),
  token: z.string().optional(),
  delta: z.number().optional(),
  ruleId: z.string().optional(),
  pattern: z.string().optional(),
  reason: z.string(),
});

export const skillFragmentSchema = z.object({
  capability: z.array(z.string()).default([]),
  heuristic: z.array(z.string()).default([]),
  workflow: z.array(z.string()).default([]),
  persona: z.array(z.string()).default([]),
});

export const distillationRecordOutputSchema = z.object({
  routing: z.object({
    action: z.enum([
      "confirm",
      "signal_adjust",
      "boundary_rule",
      "ambiguous",
    ]),
    adjustments: z.array(routingSignalAdjustmentSchema).default([]),
  }),
  skill: skillFragmentSchema,
});

export type DistillationRecordOutput = z.infer<
  typeof distillationRecordOutputSchema
>;

export const createDistillationJobSchema = z.object({
  mode: z.enum(["incremental", "full_relearn"]).default("incremental"),
  userIds: z.array(z.string()).optional(),
  timeRangeStart: z.string().datetime().optional(),
  timeRangeEnd: z.string().datetime().optional(),
  maxRecords: z.number().int().positive().max(10000).optional(),
});

export const distillationSettingsSchema = z.object({
  analysisRouteId: z.string().nullable(),
  concurrency: z.number().int().min(1).max(5).default(2),
  cronEnabled: z.boolean().default(false),
  cron: z.string().default("0 3 * * *"),
  maxRecordsPerRun: z.number().int().positive().max(5000).default(500),
});

export type DistillationSettings = z.infer<typeof distillationSettingsSchema>;
