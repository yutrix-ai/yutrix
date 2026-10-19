import { describe, expect, it } from "vitest";
import { cloneJsonSharingStrings } from "../src/utils/shareClone";

describe("cloneJsonSharingStrings", () => {
  it("reuses image payload strings and still isolates object edits", () => {
    const url = "data:image/png;base64," + "a".repeat(4096);
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
    };

    const copy = cloneJsonSharingStrings(body);
    expect(copy).not.toBe(body);
    expect(copy.messages[0].content[1].image_url.url).toBe(url);
    copy.messages[0].content[0].text = "changed";
    expect(body.messages[0].content[0].text).toBe("hello");
  });
});
