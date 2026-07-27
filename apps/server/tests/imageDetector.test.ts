import { describe, it, expect, afterEach } from "vitest";
import { isImageNode } from "../src/utils/multimodal";
import { vi } from "vitest";

describe("isImageNode", () => {
  afterEach(() => {
    
    vi.restoreAllMocks();
  });

  it("should NOT detect normal URLs as images", () => {
    expect(isImageNode({ url: "https://example.com/api" })).toBe(false);
    expect(isImageNode({ url: "https://github.com/promptgate" })).toBe(false);
    expect(isImageNode("https://docs.example.com")).toBe(false);
    expect(isImageNode({ type: "tool_result", content: [{ url: "https://example.com" }] })).toBe(false);
  });

  it("should detect explicit image structures", () => {
    expect(isImageNode({ type: "image_url", image_url: { url: "https://example.com/api" } })).toBe(true);
    expect(isImageNode({ type: "input_image", url: "https://example.com/api" })).toBe(true);
    expect(isImageNode({ type: "image", image_url: "https://example.com/api" })).toBe(true);
    expect(isImageNode({ url: "https://example.com/api.png" })).toBe(true);
    expect(isImageNode("https://example.com/api.jpg")).toBe(true);
    expect(isImageNode("data:image/png;base64,iVBORw0K")).toBe(true);
  });
});
