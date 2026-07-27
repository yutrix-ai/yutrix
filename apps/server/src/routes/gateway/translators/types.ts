export interface TranslatorState {
  [key: string]: any;
}

export interface TranslatorContext {
  modelId?: string;
  providerProtocol?: string;
}

export interface ModelTranslator {
  name: string;

  /**
   * Called on every stream chunk to translate it in-place.
   * Return true if the chunk was modified and needs to be re-stringified (for transparent paths).
   */
  translateStreamChunk(chunk: any, state: TranslatorState, context?: TranslatorContext): boolean;

  /**
   * Called for non-streaming responses to translate the message in-place.
   * Return true if the message was modified.
   */
  translateNonStreamMessage(message: any, context?: TranslatorContext): boolean;
}
