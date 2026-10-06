import { AIProviderError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { ISpeechToTextProvider, TranscribeAudioParams } from '../../core/stt/types.js';

export interface OpenAICompatibleSTTConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  providerName?: string;
}

export class OpenAICompatibleSTTProvider implements ISpeechToTextProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(config: OpenAICompatibleSTTConfig) {
    this.name = config.providerName ?? 'Groq / OpenAI Whisper';
    this.baseUrl = (config.baseUrl ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
    this.model = config.model;
    this.apiKey = config.apiKey;
  }

  async transcribe(params: TranscribeAudioParams): Promise<string> {
    const url = `${this.baseUrl}/audio/transcriptions`;
    logger.debug(`[${this.name}] Transcribiendo audio (modelo: ${this.model})`);

    const formData = new FormData();
    const fileBlob = new Blob([params.audioBuffer], { type: params.mimeType ?? 'audio/ogg' });
    formData.append('file', fileBlob, params.fileName ?? 'audio.ogg');
    formData.append('model', this.model);
    if (params.language) formData.append('language', params.language);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error(`[${this.name}] Error HTTP ${response.status}: ${errorText}`);
        throw new AIProviderError(`Error del proveedor de audio (${response.status})`, this.name, response.status);
      }

      const data = (await response.json()) as { text?: string };
      if (!data.text) {
        throw new AIProviderError('El proveedor no devolvió texto transcripto', this.name);
      }
      return data.text.trim();
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[${this.name}] Error en transcripción: ${msg}`);
      throw new AIProviderError(`Fallo al transcribir audio: ${msg}`, this.name);
    }
  }
}
