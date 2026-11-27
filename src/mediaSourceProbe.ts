/**
 * Converts player request headers to the header block expected by ffmpeg's
 * `-headers` option. The proxy never passes these headers to the native player:
 * the player only sees a local 127.0.0.1 URL.
 */
export const formatProxyHeaders = (headers: Record<string, string> | null): string => {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  return Object.keys(headers)
    .map(key => `${key}: ${headers[key]}\r\n`)
    .join('');
};
