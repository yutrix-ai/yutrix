export function isImageNode(val: any): boolean {
  if (!val) return false;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.startsWith("data:image/")) return true;
    if (trimmed.length > 256 && /^(iVBORw0K|\/9j\/|UklGR)/.test(trimmed)) return true;
    if (/^https?:\/\/.*\.(png|jpg|jpeg|webp|gif|svg|bmp)(\?.*)?$/i.test(trimmed)) return true;
    if (/^data:image\/[a-zA-Z+-]+;base64,/.test(trimmed)) return true;
    return false;
  }
  if (typeof val !== "object") return false;

  if (val.type === "image_url") {
    if (val.image_url !== undefined) return true;
  }

  if (val.type === "image") {
    if (val.source && typeof val.source === "object") {
      if (val.source.type === "base64" && typeof val.source.media_type === "string" && val.source.media_type.startsWith("image/")) return true;
      if (val.source.type === "url" && typeof val.source.url === "string") return true;
    }
    if (val.image !== undefined) {
      const mime = val.mimeType || val.mediaType || val.media_type || "";
      if (!mime || mime.startsWith("image/")) return true;
    }
    if (val.url !== undefined) return true;
  }

  if (val.type === "file") {
    if (val.data !== undefined && typeof val.mimeType === "string" && val.mimeType.startsWith("image/")) return true;
  }

  if (val.type === "input_image" || val.type === "input-image") {
    return true;
  }

  if (typeof val.url === "string") {
    if (val.url.startsWith("data:image/")) return true;
    if (/^https?:\/\/.*\.(png|jpg|jpeg|webp|gif|svg|bmp)(\?.*)?$/i.test(val.url)) return true;
  }
  if (val.image_url !== undefined) {
    if (typeof val.image_url === "string" && (val.image_url.startsWith("data:image/") || /^https?:\/\//i.test(val.image_url))) return true;
    if (val.image_url && typeof val.image_url.url === "string" && (val.image_url.url.startsWith("data:image/") || /^https?:\/\//i.test(val.image_url.url))) return true;
  }

  return false;
}

export function hasImageInput(value: any): boolean {
  if (!value) return false;
  if (isImageNode(value)) return true;
  if (Array.isArray(value)) return value.some(hasImageInput);
  if (typeof value === "object") {
    return Object.values(value).some(hasImageInput);
  }
  return false;
}

export interface NormalizedLogInfo {
  detected: boolean;
  normalized: boolean;
  details: {
    from: string;
    to: string;
    mediaType: string;
    isDataUrl: boolean;
  }[];
}

function describeImageUrl(url: string): { mediaType: string; isDataUrl: boolean } {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,/);
    return {
      mediaType: match?.[1] || "unknown",
      isDataUrl: true,
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return {
      mediaType: "url",
      isDataUrl: false,
    };
  }
  return {
    mediaType: "unknown",
    isDataUrl: false,
  };
}

function toImageUrl(data: string, mimeType: string): string {
  if (data.startsWith("data:") || /^https?:\/\//i.test(data)) return data;
  return `data:${mimeType};base64,${data}`;
}

function imageUrlFromValue(value: any): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.url === "string") return value.url;
  return "";
}

export function normalizeImageBlock(block: any, logInfo: NormalizedLogInfo): any {
  if (!block || typeof block !== "object") return block;

  // 1. Existing standard OpenAI image_url format: must be kept exactly as-is
  if (block.type === "image_url" && block.image_url && typeof block.image_url.url === "string") {
    logInfo.detected = true;
    const url = block.image_url.url;
    const { mediaType, isDataUrl } = describeImageUrl(url);
    logInfo.details.push({
      from: "image_url",
      to: "image_url",
      mediaType,
      isDataUrl
    });
    return block; // standard OpenAI image_url returned exactly as-is
  }

  // OpenAI-compatible clients sometimes send image_url as a plain string.
  if (block.type === "image_url" && typeof block.image_url === "string") {
    const { mediaType, isDataUrl } = describeImageUrl(block.image_url);
    logInfo.detected = true;
    logInfo.normalized = true;
    logInfo.details.push({
      from: "image_url (string)",
      to: "image_url",
      mediaType,
      isDataUrl
    });
    return {
      type: "image_url",
      image_url: {
        url: block.image_url
      }
    };
  }

  // 2. Anthropic style image block
  if (block.type === "image" && block.source && block.source.type === "base64" && typeof block.source.data === "string" && typeof block.source.media_type === "string") {
    const mediaType = block.source.media_type;
    // Constraint 5: mimeType must start with image/
    if (!mediaType.startsWith("image/")) {
      return block;
    }
    logInfo.detected = true;
    logInfo.normalized = true;
    logInfo.details.push({
      from: "image (anthropic)",
      to: "image_url",
      mediaType,
      isDataUrl: true
    });
    return {
      type: "image_url",
      image_url: {
        url: `data:${mediaType};base64,${block.source.data}`
      }
    };
  }

  if (block.type === "image" && block.source && block.source.type === "url" && typeof block.source.url === "string") {
    const { mediaType, isDataUrl } = describeImageUrl(block.source.url);
    logInfo.detected = true;
    logInfo.normalized = true;
    logInfo.details.push({
      from: "image (anthropic-url)",
      to: "image_url",
      mediaType,
      isDataUrl
    });
    return {
      type: "image_url",
      image_url: {
        url: block.source.url
      }
    };
  }

  // 3. AI SDK image block
  if (block.type === "image" && block.image) {
    const mimeType = block.mimeType || block.mediaType || block.media_type || "image/png";
    if (!mimeType.startsWith("image/")) {
      return block;
    }
    let dataStr = "";
    if (typeof block.image === "string") {
      dataStr = block.image;
    } else if (block.image.data && typeof block.image.data === "string") {
      dataStr = block.image.data;
    } else if (block.image instanceof Uint8Array || Buffer.isBuffer(block.image)) {
      dataStr = Buffer.from(block.image).toString("base64");
    } else {
      try {
        dataStr = String(block.image);
      } catch {
        dataStr = "";
      }
    }

    if (dataStr) {
      logInfo.detected = true;
      logInfo.normalized = true;
      const url = toImageUrl(dataStr, mimeType);
      const { mediaType, isDataUrl } = describeImageUrl(url);
      logInfo.details.push({
        from: "image (ai-sdk)",
        to: "image_url",
        mediaType: mediaType === "unknown" ? mimeType : mediaType,
        isDataUrl
      });
      return {
        type: "image_url",
        image_url: {
          url
        }
      };
    }
  }

  // 4. AI SDK file block
  if (block.type === "file" && block.data && typeof block.mimeType === "string") {
    const mimeType = block.mimeType;
    if (!mimeType.startsWith("image/")) {
      return block;
    }
    let dataStr = "";
    if (typeof block.data === "string") {
      dataStr = block.data;
    } else if (block.data.data && typeof block.data.data === "string") {
      dataStr = block.data.data;
    } else if (block.data instanceof Uint8Array || Buffer.isBuffer(block.data)) {
      dataStr = Buffer.from(block.data).toString("base64");
    } else {
      try {
        dataStr = String(block.data);
      } catch {
        dataStr = "";
      }
    }

    if (dataStr) {
      logInfo.detected = true;
      logInfo.normalized = true;
      const url = toImageUrl(dataStr, mimeType);
      const { mediaType, isDataUrl } = describeImageUrl(url);
      logInfo.details.push({
        from: "file (ai-sdk)",
        to: "image_url",
        mediaType: mediaType === "unknown" ? mimeType : mediaType,
        isDataUrl
      });
      return {
        type: "image_url",
        image_url: {
          url
        }
      };
    }
  }

  // 5. Custom / input_image style
  if (block.type === "input_image" || block.type === "input-image") {
    const mimeType = block.mimeType || block.mediaType || block.media_type || "image/png";
    if (!mimeType.startsWith("image/")) {
      return block;
    }

    const rawImage =
      (typeof block.image === "string" ? block.image : "") ||
      imageUrlFromValue(block.image_url) ||
      imageUrlFromValue(block.url);
    if (!rawImage) return block;

    logInfo.detected = true;
    logInfo.normalized = true;
    const url = toImageUrl(rawImage, mimeType);
    const { mediaType, isDataUrl } = describeImageUrl(url);
    logInfo.details.push({
      from: block.type,
      to: "image_url",
      mediaType: mediaType === "unknown" ? mimeType : mediaType,
      isDataUrl
    });
    return {
      type: "image_url",
      image_url: {
        url
      }
    };
  }

  // Unrecognized/fallback: keep as-is, don't throw
  return block;
}

export function normalizeOpenAIContentParts(content: any, logInfo: NormalizedLogInfo): any {
  if (Array.isArray(content)) {
    return content.map(block => {
      if (!block || typeof block !== "object") return block;
      if (block.type === "text" || block.type === "tool_use" || block.type === "tool_result") {
        return block;
      }
      return normalizeImageBlock(block, logInfo);
    });
  }
  return content;
}
