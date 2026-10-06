export interface TranscribeAudioParams {
  audioBuffer: Buffer;
  mimeType?: string;
  fileName?: string;
  language?: string;
}

export interface ISpeechToTextProvider {
  readonly name: string;
  transcribe(params: TranscribeAudioParams): Promise<string>;
}
