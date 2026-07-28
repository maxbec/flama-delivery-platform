import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "./signature.js";

describe("GitHub webhook signature verification", () => {
  const secret = "test-only-webhook-secret";
  const payload = Buffer.from('{"action":"completed"}');

  it("accepts the matching sha256 HMAC", () => {
    const digest = createHmac("sha256", secret).update(payload).digest("hex");
    expect(verifyGitHubSignature(payload, `sha256=${digest}`, secret)).toBe(true);
  });

  it.each([undefined, "sha1=bad", "sha256=short", "sha256=zzzz"])(
    "rejects malformed signature %s",
    (signature) => {
      expect(verifyGitHubSignature(payload, signature, secret)).toBe(false);
    },
  );
});
