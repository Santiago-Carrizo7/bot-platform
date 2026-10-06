export interface CompletePromptParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface IAIProvider {
  readonly name: string;
  completePrompt(params: CompletePromptParams): Promise<string>;
  /** Evolución futura (tool calling nativo). Opcional y sin usar en v1. */
  completeWithTools?(params: CompletePromptParams & { tools: unknown }): Promise<unknown>;
}
