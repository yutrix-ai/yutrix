import type { DistillationRecordOutput } from "@promptgate/shared";

export type LearningRecord = {
  chatLogId: string;
  userId: string;
  username: string;
  inputText: string | null;
  outputText: string | null;
  status: string | null;
  error: string | null;
  model: string | null;
  createdAt: Date;
};

export interface DistillationAnalyzer {
  analyze(record: LearningRecord): Promise<DistillationRecordOutput>;
}

/** Deterministic analyzer for tests and offline fallback — no LLM cost. */
export class HeuristicDistillationAnalyzer implements DistillationAnalyzer {
  async analyze(record: LearningRecord): Promise<DistillationRecordOutput> {
    const text = (record.inputText ?? "").toLowerCase();
    const routing: DistillationRecordOutput["routing"] = {
      action: "confirm",
      adjustments: [],
    };

    if (record.error || record.status === "error") {
      routing.action = "signal_adjust";
      routing.adjustments.push({
        type: "weight_delta",
        taskType: "debug",
        token: "error",
        delta: 1,
        reason: "error_status_debug_signal",
      });
    }
    if (text.includes("stack") || text.includes("traceback")) {
      routing.action = "signal_adjust";
      routing.adjustments.push({
        type: "weight_delta",
        taskType: "debug",
        token: "exception",
        delta: 1,
        reason: "stack_trace_debug_signal",
      });
    }
    if (text.includes("refactor") || text.includes("implement")) {
      routing.adjustments.push({
        type: "weight_delta",
        taskType: "code",
        token: "implement",
        delta: 1,
        reason: "implementation_code_signal",
      });
    }

    const skill: DistillationRecordOutput["skill"] = {
      capability: [],
      heuristic: [],
      workflow: [],
      persona: [],
    };

    if (text.includes("test") || text.includes("测试")) {
      skill.capability.push("values automated verification");
    }
    if (text.includes("why") || text.includes("为什么")) {
      skill.heuristic.push("seeks root cause before applying fixes");
    }
    if (record.error) {
      skill.workflow.push("on failure: inspect error output then narrow scope");
    }
    if (text.length > 200) {
      skill.persona.push("provides structured multi-step requests");
    } else if (text.length > 0) {
      skill.persona.push("uses concise task descriptions");
    }

    return { routing, skill };
  }
}

export const defaultDistillationAnalyzer = new HeuristicDistillationAnalyzer();
