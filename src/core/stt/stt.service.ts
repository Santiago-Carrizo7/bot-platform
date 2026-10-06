import { AppError } from '../errors/errors.js';
import { logger } from '../logging/logger.js';
import type { ISpeechToTextProvider } from './types.js';

export class SpeechToTextService {
  constructor(private readonly provider?: ISpeechToTextProvider) {}

  isConfigured(): boolean {
    return Boolean(this.provider);
  }

  async transcribe(audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<string> {
    if (!this.provider) {
      throw new AppError('El reconocimiento de voz no está configurado en el servidor.');
    }
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new AppError('El archivo de audio está vacío o no pudo descargarse.');
    }
    logger.debug(`Transcribiendo con proveedor: ${this.provider.name}`);
    const text = await this.provider.transcribe({
      audioBuffer,
      mimeType,
      fileName: 'voice.ogg',
      language: 'es',
    });
    const cleaned = text.trim();
    if (!cleaned) {
      throw new AppError('No se pudo detectar voz en el mensaje de audio.');
    }
    return cleaned;
  }
}
