import { describe, expect, it } from 'vitest';
import {
  audioConversationSchema,
  audioSpeechSchema,
  audioTranscriptionSchema,
  voiceSampleSchema,
} from '@api-platform/shared';

describe('audio studio request contracts', () => {
  it('requires bounded audio data and keeps Portuguese as the default transcription language', () => {
    expect(audioTranscriptionSchema.parse({ audio: 'YQ==', projectId: 'p1' }).language).toBe('pt');
    expect(audioTranscriptionSchema.safeParse({ audio: '' }).success).toBe(false);
    expect(audioTranscriptionSchema.safeParse({ audio: 'YQ=='.repeat(7_000_000) }).success).toBe(false);
  });

  it('validates speech text and restricts engines to the local first-party stack', () => {
    expect(audioSpeechSchema.parse({ text: 'Olá', voice: 'af_heart' }).engine).toBe('kokoro');
    expect(audioSpeechSchema.safeParse({ text: '', engine: 'cloud' }).success).toBe(false);
  });

  it('requires explicit authorization for voice samples and validates consent metadata', () => {
    expect(voiceSampleSchema.safeParse({ audio: 'YQ==', name: 'Minha voz' }).success).toBe(false);
    expect(voiceSampleSchema.parse({ audio: 'YQ==', name: 'Minha voz', authorized: true }).authorized).toBe(true);
  });

  it('requires audio input and a bounded response prompt for spoken conversations', () => {
    expect(audioConversationSchema.safeParse({ audio: 'YQ==', prompt: 'Responda' }).success).toBe(true);
    expect(audioConversationSchema.safeParse({ audio: '', prompt: '' }).success).toBe(false);
  });
});
