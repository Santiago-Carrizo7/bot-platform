import { z } from 'zod';
import { AIInterpretationError, AIProviderError } from '../errors/errors.js';
import { logger } from '../logging/logger.js';
import type { ActionDef } from '../actions/registry.js';
import type { IAIProvider } from './types.js';

const InterpretationSchema = z.object({
  action: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

export interface InterpretedAction {
  action: ActionDef<unknown>;
  /** Params crudos del modelo (aún sin validar contra el schema de la acción). */
  params: Record<string, unknown>;
}

export interface InterpretOptions {
  /** Si se continúa una conversación, se sugiere seguir con esta acción. */
  hintAction?: string;
  referenceDate?: Date;
  businessId?: string;
  maxRepairs?: number;
}

/**
 * Intérprete genérico: convierte texto libre en {action, params} dentro del
 * registry del template. La IA propone; el código valida y ejecuta.
 */
export class ActionInterpreter {
  constructor(private readonly provider: IAIProvider) {}

  async interpret(
    systemPrompt: string,
    actions: ActionDef<unknown>[],
    text: string,
    opts: InterpretOptions = {}
  ): Promise<InterpretedAction> {
    const referenceDate = (opts.referenceDate ?? new Date()).toISOString().slice(0, 10);
    const fullSystem = this.buildSystemPrompt(systemPrompt, actions, referenceDate, opts.hintAction);

    let raw = await this.callProvider(fullSystem, text);
    this.logRaw(opts.businessId, raw);

    let candidate = this.parseJson(raw, opts.businessId);
    if (!candidate) {
      // Un reintento pidiendo JSON válido antes de rendirse.
      raw = await this.callProvider(
        `${fullSystem}\n\nIMPORTANTE: tu respuesta anterior no fue un JSON válido. Respondé ÚNICAMENTE con el JSON, sin texto adicional.`,
        text
      );
      this.logRaw(opts.businessId, raw);
      candidate = this.parseJson(raw, opts.businessId);
      if (!candidate) {
        throw new AIInterpretationError(
          'No pude interpretar ese mensaje. Probá de nuevo con más detalle.',
          raw
        );
      }
    }

    const action = actions.find((a) => a.name === candidate.action);
    if (!action) {
      throw new AIInterpretationError(
        'No pude relacionar ese mensaje con ninguna función disponible.',
        raw
      );
    }
    return { action, params: candidate.params };
  }

  private async callProvider(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      return await this.provider.completePrompt({
        systemPrompt,
        userPrompt,
        temperature: 0.1,
        validateOutput: (raw) => {
          const trimmed = raw.trim();
          return trimmed.includes('{') && trimmed.includes('}');
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AIProviderError(`No se pudo procesar el mensaje con el modelo de IA: ${message}`, this.provider.name);
    }
  }

  private buildSystemPrompt(
    base: string,
    actions: ActionDef<unknown>[],
    referenceDate: string,
    hintAction?: string
  ): string {
    const list = actions.map((a) => `- ${a.name}: ${a.description}`).join('\n');
    const hint = hintAction
      ? `\nEstás continuando una conversación donde el usuario ya eligió la acción "${hintAction}". Salvo que pida claramente otra cosa, mantené esa acción y extraé sus datos del mensaje.\n`
      : '';
    return `${base}\n\nFecha de referencia (hoy): ${referenceDate}.\n${hint}\nACCIONES DISPONIBLES (usá EXACTAMENTE uno de estos nombres):\n${list}\n\nFORMATO DE RESPUESTA:\nDevolvé ÚNICAMENTE un JSON válido con esta forma, sin markdown ni texto adicional:\n{"action":"<nombre_de_accion>","params":{...datos...}}`;
  }

  private parseJson(raw: string, businessId?: string): { action: string; params: Record<string, unknown> } | null {
    const clean = extractJson(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      logger.warn('Fallo al parsear JSON devuelto por IA', { businessId, raw });
      return null;
    }
    const validation = InterpretationSchema.safeParse(parsed);
    if (!validation.success) {
      logger.warn('El JSON de la IA no cumple el formato {action, params}', { businessId, raw });
      return null;
    }
    return { action: validation.data.action, params: validation.data.params as Record<string, unknown> };
  }

  private logRaw(businessId: string | undefined, raw: string): void {
    logger.debug('Output crudo del modelo', { businessId, raw });
  }
}

/** Extrae el objeto JSON aunque venga envuelto en markdown o texto. */
export function extractJson(rawText: string): string {
  let text = rawText.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  return text.trim();
}
