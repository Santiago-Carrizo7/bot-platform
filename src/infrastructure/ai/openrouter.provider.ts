import { AIProviderError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { CompletePromptParams, IAIProvider } from '../../core/ai/types.js';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  siteUrl?: string;
  siteName?: string;
}

export class OpenRouterProvider implements IAIProvider {
  readonly name = 'OpenRouter';

  constructor(private readonly config: OpenRouterConfig) {}

  async completePrompt(params: CompletePromptParams): Promise<string> {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    if (this.config.siteUrl) headers['HTTP-Referer'] = this.config.siteUrl;
    if (this.config.siteName) headers['X-Title'] = this.config.siteName;

    try {
      logger.debug(`[${this.name}] Enviando prompt al modelo ${this.config.model}`);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          temperature: params.temperature ?? 0.1,
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        logger.error(`[${this.name}] Error HTTP ${response.status}: ${errorBody}`);
        throw new AIProviderError(
          `OpenRouter respondió con estado ${response.status}`,
          this.name,
          response.status
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new AIProviderError('OpenRouter no devolvió contenido en la respuesta', this.name);
      }
      return content;
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${this.name}] Error de conexión o ejecución: ${message}`);
      throw new AIProviderError(`Fallo al comunicarse con ${this.name}: ${message}`, this.name);
    }
  }
}
