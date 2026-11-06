/** A list of origins from an array or a comma-separated string (E9_ALLOWED_ORIGINS). */
export function parseOriginList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
