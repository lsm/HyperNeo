export type VoiceLanguage = 'auto' | 'zh' | 'en';

const STORAGE_KEY = 'hyperneo.voice.language';

export function getVoiceLanguage(): VoiceLanguage {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'zh' || value === 'en' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function setVoiceLanguage(language: VoiceLanguage): void {
  localStorage.setItem(STORAGE_KEY, language);
}
