import {formatProxyHeaders} from '../src/mediaSourceProbe';

describe('formatProxyHeaders', () => {
  it('uses LF terminators required by the Vega ffmpeg build', () => {
    expect(formatProxyHeaders({Referer: 'https://example.invalid/', 'User-Agent': 'Mozilla/5.0'}))
      .toBe('Referer: https://example.invalid/\nUser-Agent: Mozilla/5.0\n');
  });

  it('never emits CRLF, which makes origins return HTTP 400 on Vega', () => {
    expect(formatProxyHeaders({'User-Agent': 'Mozilla/5.0'})).not.toContain('\r');
  });

  it('returns an empty block when no headers are present', () => {
    expect(formatProxyHeaders(null)).toBe('');
    expect(formatProxyHeaders({})).toBe('');
  });
});
