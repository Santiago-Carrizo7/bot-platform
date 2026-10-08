import { AIProviderError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { CompletePromptParams, IAIProvider } from '../../core/ai/types.js';

export interface OpenAICompatibleChatConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  responseFormatJson?: boolean;
}

/**
 * Proveedor genérico para endpoints compatibles con OpenAI Chat Completions.
 * Usado por Groq, Google Gemini (endpoint OpenAI de AI Studio), etc.
 */
export class OpenAICompatibleChatProvider implements IAIProvider {
  readonly name: string;
  readonly model: string;

  constructor(private readonly config: OpenAICompatibleChatConfig) {
    this.name = config.name;
    this.model = config.model;
  }

  async completePrompt(params: CompletePromptParams): Promise<string> {
    const url = this.config.baseUrl.endsWith('/chat/completions')
      ? this.config.baseUrl
      : `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.extraHeaders,
    };

    const body: Record<string, unknown> = {
      model: this.config.model,
      temperature: params.temperature ?? 0.1,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
    };

    if (this.config.responseFormatJson) {
      body.response_format = { type: 'json_object' };
    }

    try {
      logger.debug(`[${this.name}] Enviando prompt al modelo ${this.config.model}`);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        logger.error(`[${this.name}] Error HTTP ${response.status}: ${errorBody}`);
        throw new AIProviderError(
          `${this.name} respondió con estado ${response.status}: ${errorBody.slice(0, 200)}`,
          this.name,
          response.status
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new AIProviderError(`${this.name} no devolvió contenido en la respuesta`, this.name);
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
