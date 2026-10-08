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

    const models = this.config.model
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);

    if (models.length === 0) {
      throw new AIProviderError('No hay modelos configurados para OpenRouter', this.name);
    }

    let lastError: Error | null = null;
    for (const model of models) {
      try {
        logger.debug(`[${this.name}] Enviando prompt al modelo: ${model}`);
        const body: Record<string, unknown> = {
          model,
          temperature: params.temperature ?? 0.1,
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userPrompt },
          ],
        };

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          logger.warn(`[${this.name}] Falló modelo ${model} (HTTP ${response.status}): ${errorBody}`);
          lastError = new AIProviderError(
            `OpenRouter (${model}) respondió con estado ${response.status}`,
            this.name,
            response.status
          );
          continue;
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          logger.warn(`[${this.name}] Modelo ${model} no devolvió contenido`);
          lastError = new AIProviderError(`Modelo ${model} no devolvió contenido`, this.name);
          continue;
        }
        return content;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(`[${this.name}] Error con modelo ${model}: ${lastError.message}`);
      }
    }

    throw new AIProviderError(
      `OpenRouter no pudo procesar la solicitud: ${lastError?.message ?? 'error desconocido'}`,
      this.name
    );
  }
}
