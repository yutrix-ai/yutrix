import { resolveProviderAdapterDetailed } from '../src/routes/gateway/providerAdapters/registry';

vi.mock('../src/routes/gateway/providerAdapters/registry', () => ({
  resolveProviderAdapterDetailed: vi.fn().mockReturnValue({
    adapter: {
      id: 'openrouter',
      createAttemptState: () => ({ terminalError: null }),
      observeStreamChunk: vi.fn(),
      observeNonStreamResponse: vi.fn(),
      classifyUpstreamError: vi.fn().mockReturnValue({ code: 'model_image_input_unsupported', errorType: 'model_capability_mismatch', requiredCapability: 'vision' })
    },
    ownerId: 'openrouter', disabled: false,
  })
}));

const res = resolveProviderAdapterDetailed("foo", "bar", {});
console.log("Mock Adapter classifyUpstreamError:", res.adapter.classifyUpstreamError());
