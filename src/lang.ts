/** True when a language code is English, or unknown (unknown is treated as English: nothing gets translated). */
export function isEnglish(lang?: string): boolean {
  if (!lang) return true;
  return /^en($|[-_])/i.test(lang);
}
