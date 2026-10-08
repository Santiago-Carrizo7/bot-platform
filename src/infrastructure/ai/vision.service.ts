import { AIProviderError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import { extractJson } from '../../core/ai/interpreter.js';

export interface LedgerItem {
  tipo: 'VENTA' | 'GASTO';
  monto: number;
  concepto?: string;
  categoria?: string;
  nota?: string;
}

export interface VisionExtractionResult {
  items: LedgerItem[];
  raw: string;
  provider: string;
  model: string;
}

export interface VisionCandidateConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VisionServiceConfig {
  geminiKey?: string;
  openRouterKey?: string;
  groqKey?: string;
}

const VISION_SYSTEM_PROMPT = `Sos un asistente contable para un kiosco. Tu tarea es analizar una foto de una libreta, cuaderno, talonario o ticket de ventas con números anotados a mano o impresos.

Extraé todos los importes que representen entradas de dinero (ventas) o salidas de dinero (gastos).
Reglas:
1. Si son solo números en lista o columna sin concepto, clasificalos como VENTA.
2. Si tienen notas como "coca", "proveedor", "pan", "luz", "gasto", etc., clasificalos como GASTO (o VENTA si dice claramente "venta").
3. Los montos deben ser números positivos limpios sin puntos de mil ni signos pesos (ej. 1500, no $1.500 ni 1.500).
4. Si la imagen está borrosa o no contiene números reconocibles, devolvé la lista vacía.

FORMATO OBLIGATORIO:
Devolvé ÚNICAMENTE un JSON con esta estructura exacta, sin markdown ni explicaciones:
{
  "items": [
    { "tipo": "VENTA", "monto": 1800, "nota": "opcional" },
    { "tipo": "GASTO", "monto": 3500, "concepto": "Coca", "categoria": "Mercadería" }
  ]
}`;

export class VisionService {
  private readonly candidates: VisionCandidateConfig[] = [];

  constructor(config: VisionServiceConfig) {
    // 1. Google Gemini directo (AI Studio: máxima precisión y gratis)
    if (config.geminiKey) {
      this.candidates.push({
        name: 'Google Gemini Vision',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey: config.geminiKey,
        model: 'gemini-2.0-flash',
      });
    }

    // 2. OpenRouter con Gemini Flash (si no hay key directa de Gemini pero sí de OpenRouter)
    if (config.openRouterKey) {
      this.candidates.push({
        name: 'OpenRouter Gemini Vision',
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: config.openRouterKey,
        model: 'google/gemini-2.0-flash-exp:free',
      });
    }

    // 3. Groq Llama 3.2 Vision (respaldo gratuito)
    if (config.groqKey) {
      this.candidates.push({
        name: 'Groq Vision',
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: config.groqKey,
        model: 'llama-3.2-11b-vision-preview',
      });
    }
  }

  isConfigured(): boolean {
    return this.candidates.length > 0;
  }

  async extractLedgerItems(imageBase64: string, mimeType = 'image/jpeg'): Promise<VisionExtractionResult> {
    if (this.candidates.length === 0) {
      throw new AIProviderError('No hay ningún proveedor de visión configurado en el servidor.', 'VisionService');
    }

    const errors: Array<{ provider: string; error: string }> = [];

    for (const candidate of this.candidates) {
      try {
        logger.debug(`[VisionService] Intentando extraer con ${candidate.name} (${candidate.model})`);
        const raw = await this.callVisionModel(candidate, imageBase64, mimeType);
        const items = this.parseItems(raw);
        return {
          items,
          raw,
          provider: candidate.name,
          model: candidate.model,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[VisionService] Falló ${candidate.name}: ${message}. Intentando siguiente proveedor...`);
        errors.push({ provider: candidate.name, error: message });
      }
    }

    const detail = errors.map((e) => `- ${e.provider}: ${e.error}`).join('\n');
    throw new AIProviderError(`Todos los proveedores de visión fallaron:\n${detail}`, 'VisionService');
  }

  private async callVisionModel(
    candidate: VisionCandidateConfig,
    imageBase64: string,
    mimeType: string
  ): Promise<string> {
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;
    const body = {
      model: candidate.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Por favor analizá esta imagen y extraé todos los importes de ventas y gastos anotados en la libreta.',
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
    };

    const response = await fetch(candidate.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${candidate.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 150)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('El modelo no devolvió contenido.');
    return content;
  }

  private parseItems(raw: string): LedgerItem[] {
    const clean = extractJson(raw);
    try {
      const parsed = JSON.parse(clean) as { items?: unknown };
      if (!Array.isArray(parsed.items)) return [];
      const items: LedgerItem[] = [];
      for (const item of parsed.items) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as Record<string, unknown>;
        const rawMonto = Number(candidate.monto ?? candidate.amount);
        if (Number.isFinite(rawMonto) && rawMonto > 0) {
          const tipo = String(candidate.tipo ?? candidate.type).toUpperCase() === 'GASTO' ? 'GASTO' : 'VENTA';
          items.push({
            tipo,
            monto: Math.round(rawMonto * 100) / 100,
            concepto: typeof candidate.concepto === 'string' ? candidate.concepto : undefined,
            categoria: typeof candidate.categoria === 'string' ? candidate.categoria : undefined,
            nota: typeof candidate.nota === 'string' ? candidate.nota : undefined,
          });
        }
      }
      return items;
    } catch {
      logger.warn('[VisionService] No se pudo parsear el JSON devuelto por visión', { raw });
      return [];
    }
  }
}
