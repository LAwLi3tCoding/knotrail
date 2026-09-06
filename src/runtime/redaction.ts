const replacement = '[redacted]';
export function redact<T>(value: T, secret?: string): T {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join(replacement) as T;
  if (Array.isArray(value)) return value.map(item => redact(item, secret)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secret), redact(item, secret)])) as T;
  return value;
}

/** Keep a possible credential prefix until the next text delta resolves it. */
export class RedactedStream {
  private pending = '';
  constructor(private secret?: string) {}
  push(text: string): string {
    if (!this.secret) return text;
    const value = redact(this.pending + text, this.secret);
    let held = Math.min(this.secret.length - 1, value.length);
    while (held && !this.secret.startsWith(value.slice(-held))) held--;
    this.pending = held ? value.slice(-held) : '';
    return held ? value.slice(0, -held) : value;
  }
  finish(): string { const value = this.pending; this.pending = ''; return value; }
}
