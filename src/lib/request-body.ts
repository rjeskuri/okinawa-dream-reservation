// The body reader of the publish routes, which anyone can call before the signature check: both read through it, so
// neither reads more than the limit, however the body arrives (#103).

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The body as text, or null past the limit. Counted as it arrives, so a sender cannot keep the Worker reading. The count
 * is of the bytes before decoding, and bytes that are not UTF-8 decode to U+FFFD rather than throwing, so they reach the
 * signature check like any other text.
 */
export async function readBody(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) return null;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
