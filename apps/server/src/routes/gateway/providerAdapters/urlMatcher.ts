export interface NormalizedUrlResult {
  isValid: boolean;
  hostname: string;
  pathname: string;
  normalizedBaseUrl: string;
}

export function parseAndNormalizeUrl(urlStr: string): NormalizedUrlResult {
  if (!urlStr || typeof urlStr !== "string") {
    return {
      isValid: false,
      hostname: "",
      pathname: "",
      normalizedBaseUrl: "",
    };
  }

  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // Normalize pathname
    let pathname = url.pathname;

    // Construct normalizedBaseUrl (origin + pathname without trailing slash)
    let normalizedBaseUrl = url.origin + pathname;
    if (normalizedBaseUrl.endsWith("/")) {
      normalizedBaseUrl = normalizedBaseUrl.slice(0, -1);
    }

    return {
      isValid: true,
      hostname,
      pathname,
      normalizedBaseUrl,
    };
  } catch (err) {
    // Graceful failure - do not throw
    return {
      isValid: false,
      hostname: "",
      pathname: "",
      normalizedBaseUrl: "",
    };
  }
}
