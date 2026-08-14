/**
 * Group/user input clipping vs Long Context overflow hop.
 * Pure decision — hop is driven before the outbound body is mutated.
 */

export type GroupClipOverflowDecision = {
  hop: boolean;
  preferVision: boolean;
  /** This overflow path must not use the 1M long_context classification floor. */
  applyOneMillionFloor: boolean;
};

export function decideGroupClipOverflow(input: {
  droppedTurns: number;
  originalTokens?: number;
  hasImages?: boolean;
}): GroupClipOverflowDecision {
  if (!Number.isFinite(input.droppedTurns) || input.droppedTurns <= 0) {
    return { hop: false, preferVision: false, applyOneMillionFloor: false };
  }
  return {
    hop: true,
    preferVision: input.hasImages === true,
    applyOneMillionFloor: false,
  };
}

export function shouldOverflowHopInsteadOfClip(truncation: {
  droppedTurns?: number;
  truncated?: boolean;
}): boolean {
  return decideGroupClipOverflow({ droppedTurns: Number(truncation.droppedTurns) || 0 }).hop;
}

export function overflowHopTaskOrder(hasImages: boolean): Array<"vision" | "long_context"> {
  return hasImages ? ["vision", "long_context"] : ["long_context"];
}

export type OverflowHopCandidate = {
  providerId: string;
  providerProtocol: string;
  modelId: string;
  targetIndex?: number;
  windowLimit: number;
};

export type GroupClipOverflowHopResult =
  | {
      action: "hop";
      taskType: "vision" | "long_context";
      providerId: string;
      providerProtocol: string;
      modelId: string;
      targetIndex?: number;
      clipToWindow: number | null;
    }
  | { action: "stay"; clipToWindow: number | null }
  | { action: "last_resort_group_clip" };

function clipWindowOrNull(windowLimit: number): number | null {
  return Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : null;
}

function windowHoldsUnclipped(windowLimit: number, estimatedTokens: number, safetyMargin: number): boolean {
  if (!Number.isFinite(windowLimit) || windowLimit <= 0) return true;
  return estimatedTokens + safetyMargin <= windowLimit;
}

/**
 * Group-clip overflow: hop to configured LC even when its window is smaller
 * than the unclipped estimate. Clip to that hopped window afterwards.
 * Vision is only chosen when its window can hold the unclipped body.
 */
export function resolveGroupClipOverflowHop(input: {
  hasImages: boolean;
  estimatedTokens: number;
  currentProviderId: string;
  currentModelId: string;
  safetyMargin?: number;
  visionCandidates: OverflowHopCandidate[];
  longContextCandidate: OverflowHopCandidate | null;
}): GroupClipOverflowHopResult {
  const safetyMargin = input.safetyMargin ?? 50;
  const estimatedTokens = Number(input.estimatedTokens) || 0;

  if (input.hasImages) {
    for (const vision of input.visionCandidates) {
      if (
        vision.providerId === input.currentProviderId
        && vision.modelId === input.currentModelId
      ) {
        continue;
      }
      if (windowHoldsUnclipped(vision.windowLimit, estimatedTokens, safetyMargin)) {
        return {
          action: "hop",
          taskType: "vision",
          providerId: vision.providerId,
          providerProtocol: vision.providerProtocol,
          modelId: vision.modelId,
          targetIndex: vision.targetIndex,
          clipToWindow: clipWindowOrNull(vision.windowLimit),
        };
      }
    }
  }

  const lc = input.longContextCandidate;
  if (!lc) {
    return { action: "last_resort_group_clip" };
  }

  if (lc.providerId === input.currentProviderId && lc.modelId === input.currentModelId) {
    return { action: "stay", clipToWindow: clipWindowOrNull(lc.windowLimit) };
  }

  return {
    action: "hop",
    taskType: "long_context",
    providerId: lc.providerId,
    providerProtocol: lc.providerProtocol,
    modelId: lc.modelId,
    clipToWindow: clipWindowOrNull(lc.windowLimit),
  };
}
