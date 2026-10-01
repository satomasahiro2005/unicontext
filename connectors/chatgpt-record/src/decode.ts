/** utf-8 (BOM stripped); UTF-16 by BOM; Shift_JIS when the bytes are not valid utf-8. */
export function decodeText(buf: Uint8Array): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const body =
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? buf.subarray(3)
      : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(body);
    } catch {
      return new TextDecoder('latin1').decode(body);
    }
  }
}
