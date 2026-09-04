import { beforeEach, describe, expect, it, vi } from "vitest";

const getAutoUpdate = vi.fn(async () => true);
const maybeAutoUpdate = vi.fn(async () => undefined);

vi.mock("../src/opencode/settings", () => ({
  getOpencodeAutoUpdate: (...args: unknown[]) => getAutoUpdate(...args),
}));

vi.mock("../src/opencode/opencodeService", () => ({
  OpencodeService: {
    getInstance: () => ({
      maybeAutoUpdate,
    }),
  },
}));

describe("OpenCode auto-update scheduler", () => {
  beforeEach(() => {
    getAutoUpdate.mockReset();
    maybeAutoUpdate.mockReset();
    getAutoUpdate.mockResolvedValue(true);
    maybeAutoUpdate.mockResolvedValue(undefined);
  });

  it("runs sidecar update when the setting is on (default)", async () => {
    const { runOpencodeAutoUpdate } = await import("../src/opencode/autoUpdate");
    await runOpencodeAutoUpdate();
    expect(maybeAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("skips sidecar update when the setting is off", async () => {
    getAutoUpdate.mockResolvedValue(false);
    const { runOpencodeAutoUpdate } = await import("../src/opencode/autoUpdate");
    await runOpencodeAutoUpdate();
    expect(maybeAutoUpdate).not.toHaveBeenCalled();
  });
});
