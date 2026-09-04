import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpencodeService } from "../src/opencode/opencodeService";
import { executeOpencodeSessionApi } from "../src/opencode/opencodeClient";

vi.mock("../src/opencode/opencodeService", () => {
  const syncCredential = vi.fn().mockResolvedValue(undefined);
  return {
    OpencodeService: {
      getInstance: () => ({
        port: 23456,
        syncCredential,
      })
    }
  };
});

describe("Opencode Client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should sync key and call session api", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ses_123" })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({ parts: [{ type: "text", text: "Hello from opencode!" }] })
      });
    global.fetch = fetchMock;

    const controller = new AbortController();
    const result = await executeOpencodeSessionApi(
      { messages: [{ content: "Hi" }] },
      "openrouter",
      "gpt-4o",
      "test-key",
      controller
    );

    expect(result.status).toBe(200);
    expect(result.responseData.choices[0].message.content).toBe("Hello from opencode!");
    
    // Check fetch calls
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/session");
    
    const sessionCallBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sessionCallBody.title).toBe("gateway request");
    
    expect(fetchMock.mock.calls[1][0]).toContain("/session/ses_123/message");
    
    const msgCallBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(msgCallBody.model.providerID).toBe("openrouter");
    expect(msgCallBody.parts[0].text).toBe("Hi");
  });

  it("should return 429 when rate limited", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limited"
      });
    global.fetch = fetchMock;

    const controller = new AbortController();
    const result = await executeOpencodeSessionApi(
      { messages: [{ content: "Hi" }] },
      "openrouter",
      "gpt-4o",
      "test-key",
      controller
    );

    expect(result.status).toBe(429);
  });
});
