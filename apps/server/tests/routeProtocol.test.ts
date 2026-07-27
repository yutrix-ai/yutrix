import { describe, expect, it } from "vitest";
import {
  getSelectableModels,
  resolveRouteProviderProtocol,
} from "../src/utils/routeProtocol";

const models = [
  { modelId: "gpt-4o", protocol: "openai" },
  { modelId: "claude-3-5", protocol: "anthropic" },
];

describe("route protocol selection", () => {
  it("selects all provider models for OpenAI routes when OpenAI URL is configured", () => {
    expect(
      getSelectableModels({
        incomingProtocol: "openai",
        provider: { hasOpenaiEndpoint: true, hasAnthropicEndpoint: true },
        models,
      }).map((model) => model.modelId),
    ).toEqual(["gpt-4o", "claude-3-5"]);
  });

  it("routes Anthropic requests directly when Anthropic URL is configured", () => {
    const selectable = getSelectableModels({
      incomingProtocol: "anthropic",
      provider: { hasOpenaiEndpoint: true, hasAnthropicEndpoint: true },
      models,
    });

    expect(selectable.map((model) => model.modelId)).toEqual([
      "gpt-4o",
      "claude-3-5",
    ]);
    expect(
      resolveRouteProviderProtocol({
        incomingProtocol: "anthropic",
        provider: { hasOpenaiEndpoint: true, hasAnthropicEndpoint: true },
        models,
        modelId: "gpt-4o",
      }),
    ).toEqual({ ok: true, providerProtocol: "anthropic" });
  });

  it("rejects unknown models even when Anthropic URL is configured", () => {
    expect(
      resolveRouteProviderProtocol({
        incomingProtocol: "anthropic",
        provider: { hasOpenaiEndpoint: true, hasAnthropicEndpoint: true },
        models,
        modelId: "missing",
      }),
    ).toEqual({
      ok: false,
      error: "目标模型不属于该供应商",
    });
  });

  it("allows Anthropic to OpenAI-compatible fallback only without Anthropic URL", () => {
    expect(
      resolveRouteProviderProtocol({
        incomingProtocol: "anthropic",
        provider: { hasOpenaiEndpoint: true, hasAnthropicEndpoint: false },
        models,
        modelId: "claude-3-5",
      }),
    ).toEqual({ ok: true, providerProtocol: "openai" });
  });

  it("rejects Anthropic routes without Anthropic or OpenAI URL", () => {
    expect(
      resolveRouteProviderProtocol({
        incomingProtocol: "anthropic",
        provider: { hasOpenaiEndpoint: false, hasAnthropicEndpoint: false },
        models,
        modelId: "gpt-4o",
      }),
    ).toEqual({
      ok: false,
      error: "该供应商没有配置 Anthropic 协议 URL，也没有可用于协议适配的 OpenAI 协议 URL。",
    });
  });
});
