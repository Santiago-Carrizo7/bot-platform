import { AIProviderError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { CompletePromptParams, IAIProvider } from '../../core/ai/types.js';

/**
 * Proveedor compuesto en cascada (failover):
 * Prueba en orden una lista de proveedores (ej. Groq -> OpenRouter -> Gemini).
 * Si un proveedor falla por cuota/rate-limit (429), error de servidor (5xx),
 * timeout o si la respuesta no pasa la validación de salida, pasa al siguiente.
 */
export class FallbackAIProvider implements IAIProvider {
  readonly name: string;

  constructor(readonly providers: IAIProvider[]) {
    if (providers.length === 0) {
      throw new Error('FallbackAIProvider requiere al menos un proveedor configurado.');
    }
    this.name = `Fallback(${providers.map((p) => p.name).join(' -> ')})`;
  }

  async completePrompt(params: CompletePromptParams): Promise<string> {
    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of this.providers) {
      try {
        logger.debug(`[${this.name}] Intentando con proveedor: ${provider.name}`);
        const result = await provider.completePrompt(params);

        if (params.validateOutput && !params.validateOutput(result)) {
          const warnMsg = `La respuesta de ${provider.name} no superó la validación (posible output corrupto o no-JSON)`;
          logger.warn(`[${this.name}] ${warnMsg}. Pasando al siguiente proveedor de la cascada...`, {
            raw: result.slice(0, 100),
          });
          errors.push({ provider: provider.name, error: warnMsg });
          continue;
        }

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[${this.name}] Falló el proveedor ${provider.name}: ${message}. Pasando al siguiente proveedor de la cascada...`
        );
        errors.push({ provider: provider.name, error: message });
      }
    }

    const detail = errors.map((e) => `- ${e.provider}: ${e.error}`).join('\n');
    throw new AIProviderError(`Todos los proveedores de la cascada fallaron:\n${detail}`, this.name);
  }
}
