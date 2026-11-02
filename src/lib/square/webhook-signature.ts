// Square signs each webhook notification with the base64 HMAC-SHA256 of the notification URL followed by the raw body.
import { hmacSha256Base64, timingSafeEqual } from "../crypto.ts";

export type SquareSignatureInput = {
  signatureKey: string;
  /** Must equal SQUARE_WEBHOOK_URL exactly: the bytes Square signed, not a normalised form of them. */
  notificationUrl: string;
  rawBody: string;
  /** The x-square-hmacsha256-signature header, null when it is absent. */
  signature: string | null;
};

/** An empty key resolves false rather than rejecting: WebCrypto refuses a zero-length key. */
export async function verifySquareSignature({
  signatureKey,
  notificationUrl,
  rawBody,
  signature,
}: SquareSignatureInput): Promise<boolean> {
  if (!signatureKey || !signature) return false;
  const expected = await hmacSha256Base64(signatureKey, notificationUrl + rawBody);
  return timingSafeEqual(signature, expected);
}
