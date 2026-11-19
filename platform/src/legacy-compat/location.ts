/** The `Location` header of ColdFusion `location(url, false)` (core/mura/login/loginManager.cfc:154,240). */

/** `text` with each character `pattern` matches as `%` and two lowercase hex digits of its code. */
function percentEscaped(text: string, pattern: RegExp): string {
  return text.replace(pattern, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Header bytes Node's HTTP server writes in no header value: every C0 control but TAB, and DEL. */
const NODE_REFUSED_BYTES = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * The header bytes ACF sends for `location(url, false)`: CR, LF and NUL dropped, other C0 controls as `%xx`, then `%0a`
 * and then `%0d` removed in one pass each, ignoring case; the container then writes each UTF-16 unit as its low byte, a
 * CR or LF byte as a space. The scrub is not idempotent, so a URL takes it once.
 * @returns One character per header byte, each at most U+00FF.
 */
function acfLocationBytes(url: string): string {
  const scrubbed = percentEscaped(url.replace(/[\r\n\0]/g, ''), /[\u0001-\u001f]/g)
    .replace(/%0a/gi, '')
    .replace(/%0d/gi, '');
  let bytes = '';
  for (let i = 0; i < scrubbed.length; i += 1) {
    const low = scrubbed.charCodeAt(i) & 0xff;
    bytes += String.fromCharCode(low === 0x0a || low === 0x0d ? 0x20 : low);
  }
  return bytes;
}

/**
 * The header ACF sends for `location(url, false)` ({@link acfLocationBytes}), except that a byte Node sends in no header
 * goes out as `%xx` where legacy sends it raw.
 * @returns One character per header byte, each at most U+00FF.
 */
export function cfLocationHeader(url: string): string {
  return percentEscaped(acfLocationBytes(url), new RegExp(NODE_REFUSED_BYTES.source, 'g'));
}

/** Whether ACF's `location(url, false)` header for `url` holds a byte Node's HTTP server writes in no header value. */
export function sendsNodeRefusedLocationBytes(url: string): boolean {
  return NODE_REFUSED_BYTES.test(acfLocationBytes(url));
}
