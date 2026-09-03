import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createDistillationJobSchema,
  distillationSettingsSchema,
} from "@promptgate/shared";
import {
  applyValidatedProposals,
  cancelDistillationJob,
  createDistillationJob,
  getDistillationJob,
  getLatestSkillPackage,
  listDistillationJobs,
  listRoutingProposals,
  listSkillPackages,
  pauseDistillationJob,
  resumeDistillationJob,
  rollbackRoutingOverlay,
  validateDraftProposals,
} from "../services/distillation/jobService";
import {
  getDistillationSettings,
  updateDistillationSettings,
} from "../services/distillation/settingsService";
import { buildSkillZipBuffer } from "../services/distillation/skillZipExporter";
import { scheduleDistillationJobs } from "../services/distillation/scheduler";
import { getActiveRoutingOverlay } from "../services/distillation/routingOverlay";

export async function getSettings(_req: FastifyRequest, reply: FastifyReply) {
  reply.send(await getDistillationSettings());
}

export async function patchSettings(req: FastifyRequest, reply: FastifyReply) {
  const parsed = distillationSettingsSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const next = await updateDistillationSettings(parsed.data);
  await scheduleDistillationJobs();
  reply.send(next);
}

export async function listJobs(_req: FastifyRequest, reply: FastifyReply) {
  reply.send(await listDistillationJobs());
}

export async function createJob(req: FastifyRequest, reply: FastifyReply) {
  const parsed = createDistillationJobSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  try {
    const input = {
      mode: parsed.data.mode,
      userIds: parsed.data.userIds,
      timeRangeStart: parsed.data.timeRangeStart
        ? new Date(parsed.data.timeRangeStart)
        : undefined,
      timeRangeEnd: parsed.data.timeRangeEnd
        ? new Date(parsed.data.timeRangeEnd)
        : undefined,
      maxRecords: parsed.data.maxRecords,
    };
    const result = await createDistillationJob(input);
    reply.code(201).send(result);
  } catch (e: any) {
    reply.code(409).send({ error: e.message });
  }
}

export async function getJob(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const job = await getDistillationJob(req.params.id);
  if (!job) return reply.code(404).send({ error: "Job not found" });
  reply.send(job);
}

export async function pauseJob(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  try {
    await pauseDistillationJob(req.params.id);
    reply.send({ ok: true });
  } catch (e: any) {
    if (e.message === "Job not found") {
      return reply.code(404).send({ error: e.message });
    }
    return reply.code(409).send({ error: e.message });
  }
}

export async function resumeJob(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  try {
    await resumeDistillationJob(req.params.id);
    reply.send({ ok: true });
  } catch (e: any) {
    if (e.message === "Job not found") {
      return reply.code(404).send({ error: e.message });
    }
    return reply.code(409).send({ error: e.message });
  }
}

export async function cancelJob(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  try {
    await cancelDistillationJob(req.params.id);
    reply.send({ ok: true });
  } catch (e: any) {
    if (e.message === "Job not found") {
      return reply.code(404).send({ error: e.message });
    }
    return reply.code(409).send({ error: e.message });
  }
}

export async function getProposals(req: FastifyRequest, reply: FastifyReply) {
  const status =
    typeof (req.query as { status?: string }).status === "string"
      ? (req.query as { status: string }).status
      : undefined;
  reply.send(await listRoutingProposals(status));
}

export async function postValidate(_req: FastifyRequest, reply: FastifyReply) {
  reply.send(await validateDraftProposals());
}

export async function postApply(_req: FastifyRequest, reply: FastifyReply) {
  try {
    reply.send(await applyValidatedProposals());
  } catch (e: any) {
    reply.code(400).send({ error: e.message });
  }
}

export async function postRollback(_req: FastifyRequest, reply: FastifyReply) {
  await rollbackRoutingOverlay();
  reply.send({ ok: true });
}

export async function getRoutingOverlay(
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  reply.send({ active: await getActiveRoutingOverlay() });
}

export async function listSkills(_req: FastifyRequest, reply: FastifyReply) {
  reply.send(await listSkillPackages());
}

export async function getSkill(
  req: FastifyRequest<{ Params: { userId: string } }>,
  reply: FastifyReply,
) {
  const pkg = await getLatestSkillPackage(req.params.userId);
  if (!pkg) return reply.code(404).send({ error: "Skill not found" });
  reply.send({
    ...pkg,
    files: JSON.parse(pkg.files) as Record<string, string>,
  });
}

export async function downloadSkill(
  req: FastifyRequest<{ Params: { userId: string } }>,
  reply: FastifyReply,
) {
  const pkg = await getLatestSkillPackage(req.params.userId);
  if (!pkg) return reply.code(404).send({ error: "Skill not found" });
  const files = JSON.parse(pkg.files) as Record<string, string>;
  const zip = buildSkillZipBuffer(files);
  const filename = `${pkg.username}-skill-v${pkg.version}.zip`;
  reply
    .header("Content-Type", "application/zip")
    .header("Content-Disposition", `attachment; filename="${filename}"`)
    .send(zip);
}
