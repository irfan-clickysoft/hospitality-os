const SENSITIVE = /(password|secret|token|cnic|passport|id_number|card|cvv|pan|authorization)/i;

/** Deep-copies a value for the audit log, masking sensitive keys so credentials and identity numbers never reach the trail. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[TRUNCATED]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : typeof v === 'bigint' ? v.toString() : redact(v, depth + 1);
  }
  return out;
}
