import { ProviderAdapter, ProviderAdapterContext } from "./types";

export const transparentAdapter: ProviderAdapter = {
  id: "transparent",
  match(_context: ProviderAdapterContext): boolean {
    return false; // The registry manually resolves this as default if no other matches
  },
  createAttemptState(_context: ProviderAdapterContext): any {
    return {};
  },
  getRequestPolicy(_context: ProviderAdapterContext) {
    return {};
  },
  observeStreamChunk() {},
  transformStreamChunk() {
    return false;
  },
  observeNonStreamResponse() {},
  transformNonStreamResponse() {
    return false;
  },
};
