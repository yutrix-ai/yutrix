import type { DistillationRecordOutput } from "@promptgate/shared";

type SkillFragment = DistillationRecordOutput["skill"];

export type ConsolidatedSkillPackage = {
  userId: string;
  username: string;
  version: number;
  files: Record<string, string>;
};

function uniqLines(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const k = item.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item.trim());
  }
  return out;
}

export function consolidateSkillFragments(input: {
  userId: string;
  username: string;
  version: number;
  fragments: SkillFragment[];
}): ConsolidatedSkillPackage {
  const capability = uniqLines(
    input.fragments.flatMap((f) => f.capability),
  );
  const heuristic = uniqLines(input.fragments.flatMap((f) => f.heuristic));
  const workflow = uniqLines(input.fragments.flatMap((f) => f.workflow));
  const persona = uniqLines(input.fragments.flatMap((f) => f.persona));

  const slug = input.username.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const skillMd = `---
name: colleague-${slug}
description: >
  Abstract engineering colleague profile distilled from gateway audit logs.
  Contains no business-specific cases or project details.
metadata:
  userId: ${input.userId}
  displayName: ${input.username}
  version: ${input.version}
  schema: colleague-skill-v1
---

# Colleague Skill — ${input.username}

Distilled abstract engineering practices. Not business documentation.
`;

  const files: Record<string, string> = {
    "SKILL.md": skillMd,
    "capability.md": capability.map((l) => `- ${l}`).join("\n") || "- (none yet)",
    "playbook.md": workflow.map((l) => `- ${l}`).join("\n") || "- (none yet)",
    "persona.md": persona.map((l) => `- ${l}`).join("\n") || "- (none yet)",
    "heuristics.md": heuristic.map((l) => `- ${l}`).join("\n") || "- (none yet)",
    "meta.json": JSON.stringify(
      {
        userId: input.userId,
        username: input.username,
        version: input.version,
        generatedAt: new Date().toISOString(),
        abstractOnly: true,
      },
      null,
      2,
    ),
  };

  return {
    userId: input.userId,
    username: input.username,
    version: input.version,
    files,
  };
}
