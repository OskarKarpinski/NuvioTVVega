/**
 * Converts player request headers to the header block expected by ffmpeg's
 * `-headers` option. The proxy never passes these headers to the native player:
 * the player only sees a local 127.0.0.1 URL.
 *
 * Vega's ffmpeg build keeps a trailing `\r` in the last header value when we
 * send CRLF line endings, which makes origins return HTTP 400. LF is the
 * terminator this build actually parses correctly.
 */
export const formatProxyHeaders = (headers: Record<string, string> | null): string => {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  return Object.keys(headers)
    .map(key => `${key}: ${headers[key]}\n`)
    .join('');
};
