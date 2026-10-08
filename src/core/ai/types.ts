export interface CompletePromptParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  /** Validador opcional: si devuelve false, proveedores compuestos (como Fallback) prueban el siguiente candidato. */
  validateOutput?: (output: string) => boolean;
}

export interface IAIProvider {
  readonly name: string;
  completePrompt(params: CompletePromptParams): Promise<string>;
  /** Evolución futura (tool calling nativo). Opcional y sin usar en v1. */
  completeWithTools?(params: CompletePromptParams & { tools: unknown }): Promise<unknown>;
}
