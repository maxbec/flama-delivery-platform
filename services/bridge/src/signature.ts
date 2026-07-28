import { createHmac, timingSafeEqual } from "node:crypto";

const signaturePattern = /^sha256=([0-9a-f]{64})$/;

export function verifyGitHubSignature(
  payload: Buffer,
  signature: string | undefined,
  webhookSecret: string,
): boolean {
  if (signature === undefined || webhookSecret.length === 0) return false;
  const match = signaturePattern.exec(signature);
  if (match === null) return false;

  const supplied = Buffer.from(match[1] ?? "", "hex");
  const expected = createHmac("sha256", webhookSecret).update(payload).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
