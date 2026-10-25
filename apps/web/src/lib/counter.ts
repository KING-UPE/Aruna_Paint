/**
 * A billing PC opens the POS as http://server:3000/?counter=C1 (the desktop shell does this);
 * the counter code is remembered on this PC so every login here is at that counter.
 */
const KEY = 'aruna.counterCode';

export function rememberCounterFromUrl(): void {
  const code = new URLSearchParams(window.location.search).get('counter');
  if (code) {
    try {
      localStorage.setItem(KEY, code.toUpperCase());
    } catch {
      // Private mode: the code still works for this page load.
    }
  }
}

export function counterCode(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('counter');
  if (fromUrl) return fromUrl.toUpperCase();
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setCounterCode(code: string | null): void {
  try {
    if (code) localStorage.setItem(KEY, code.toUpperCase());
    else localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
