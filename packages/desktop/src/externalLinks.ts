const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function normalizeExternalHttpUrl(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  const value = input.trim();
  if (!value || hasControlCharacter(value)) {
    return null;
  }

  try {
    const url = new URL(value);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
