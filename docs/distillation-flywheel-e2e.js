#!/usr/bin/env node
/**
 * E2E smoke test for Distillation Flywheel API.
 * Usage: node docs/distillation-flywheel-e2e.js [baseUrl] [adminToken]
 */
const base = process.argv[2] || "http://127.0.0.1:3000";
const token = process.argv[3] || process.env.ADMIN_TOKEN;

async function api(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

async function main() {
  console.log("[e2e] distillation flywheel");
  const settings = await api("/api/admin/distillation/settings");
  console.log("settings", settings);

  const created = await api("/api/admin/distillation/jobs", {
    method: "POST",
    body: JSON.stringify({ mode: "incremental", maxRecords: 10 }),
  });
  console.log("job", created.jobId);

  await new Promise((r) => setTimeout(r, 3000));

  const job = await api(`/api/admin/distillation/jobs/${created.jobId}`);
  console.log("job status", job.status, job.processedItems, "/", job.totalItems);

  const validation = await api("/api/admin/distillation/proposals/validate", {
    method: "POST",
  });
  console.log("validation", validation);

  if (validation.ok) {
    const applied = await api("/api/admin/distillation/proposals/apply", {
      method: "POST",
    });
    console.log("applied", applied);
  }

  const skills = await api("/api/admin/distillation/skills");
  console.log("skills", skills.length);

  console.log("[e2e] PASS");
}

main().catch((e) => {
  console.error("[e2e] FAIL", e.message);
  process.exit(1);
});
