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
