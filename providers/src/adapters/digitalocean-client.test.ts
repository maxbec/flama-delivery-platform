import { describe, expect, it, vi } from "vitest";
import { DigitalOceanRestAppClient } from "./digitalocean-client.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const credential = { reveal: () => "test-only-digitalocean-token" };
const spec = {
  name: "flama-api",
  services: [{ name: "api", image: { registry_type: "GHCR" as const, repository: "api", digest: `sha256:${"5".repeat(64)}` } }],
};

describe("digitalocean app client", () => {
  it("reads an app spec from the documented envelope", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return json({ app: { spec } });
    });

    const result = await new DigitalOceanRestAppClient(credential, fetcher).getApp("abc-123");

    expect(result.spec).toEqual(spec);
    expect(requests[0]?.url).toBe("https://api.digitalocean.com/v2/apps/abc-123");
    expect(requests[0]?.init?.method).toBe("GET");
    expect((requests[0]?.init?.headers as Record<string, string>)["Authorization"])
      .toBe("Bearer test-only-digitalocean-token");
  });

  it("forces the source version update, or the digest change would be ignored", async () => {
    // DigitalOcean documents that update_all_source_versions defaults to false and
    // that only newly added sources are updated in that case. Without it a changed
    // digest is silently not applied and the app keeps serving the old image.
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return json({ app: { spec } });
    });

    await new DigitalOceanRestAppClient(credential, fetcher).updateApp("abc-123", spec);

    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ spec, update_all_source_versions: true });
  });

  it("uses PUT for a spec update", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return json({ app: { spec } });
    });

    await new DigitalOceanRestAppClient(credential, fetcher).updateApp("abc-123", spec);

    expect(requests[0]?.init?.method).toBe("PUT");
    expect(requests[0]?.url).toBe("https://api.digitalocean.com/v2/apps/abc-123");
  });

  it("never asks App Platform to rebuild source when creating a deployment", async () => {
    const bodies: string[] = [];
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push(String(url));
      bodies.push(String(init?.body));
      return json({ deployment: { id: "dep-9", phase: "PENDING_BUILD" } });
    });

    const deployment = await new DigitalOceanRestAppClient(credential, fetcher).createDeployment("abc-123");

    expect(deployment).toEqual({ id: "dep-9", phase: "PENDING_BUILD" });
    expect(requests[0]).toBe("https://api.digitalocean.com/v2/apps/abc-123/deployments");
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ force_build: false });
  });

  it("reads a deployment phase from the documented envelope", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      requests.push(String(url));
      return json({ deployment: { id: "dep-9", phase: "ACTIVE" } });
    });

    const deployment = await new DigitalOceanRestAppClient(credential, fetcher)
      .getDeployment("abc-123", "dep-9");

    expect(deployment.phase).toBe("ACTIVE");
    expect(requests[0]).toBe("https://api.digitalocean.com/v2/apps/abc-123/deployments/dep-9");
  });

  it("rejects a failed response without surfacing its body", async () => {
    const fetcher = vi.fn(async () => json({ id: "unauthorized", message: "secret detail" }, 401));

    await expect(new DigitalOceanRestAppClient(credential, fetcher).getApp("abc-123"))
      .rejects.toThrow(/digitalocean request failed/u);
  });

  it("rejects a response that does not carry the expected envelope", async () => {
    const fetcher = vi.fn(async () => json({ app: {} }));

    await expect(new DigitalOceanRestAppClient(credential, fetcher).getApp("abc-123")).rejects.toThrow();
  });

  it("rejects an identifier that would escape the endpoint path", async () => {
    const fetcher = vi.fn(async () => json({ app: { spec } }));

    await expect(new DigitalOceanRestAppClient(credential, fetcher).getApp("../droplets"))
      .rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never follows a redirect", async () => {
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return json({ app: { spec } });
    });

    await new DigitalOceanRestAppClient(credential, fetcher).getApp("abc-123");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
