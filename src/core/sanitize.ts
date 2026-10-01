// AI text is shaped by untrusted MR content (prompt injection). Rendered markdown can load remote images, which
// would let injected instructions exfiltrate data in an image URL with no click. Strip images and raw HTML.

const MD_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_IMAGE_REF = /!\[([^\]]*)\]\[[^\]]*\]/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

export function sanitizeAiText(text: string): string {
  return text.replace(MD_IMAGE, '[image removed: $1]').replace(MD_IMAGE_REF, '[image removed: $1]').replace(HTML_TAG, '');
}

/** Deep-sanitize every string in an AI response object. */
export function sanitizeAiOutput<T>(value: T): T {
  if (typeof value === 'string') return sanitizeAiText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeAiOutput(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeAiOutput(v)])) as T;
  }
  return value;
}
