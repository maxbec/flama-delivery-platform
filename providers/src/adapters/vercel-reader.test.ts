import { describe, expect, it, vi } from "vitest";
import { VercelRestDeploymentReader } from "./vercel-reader.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const deployment = {
  url: "app-def456.vercel.app",
  readyState: "READY",
  target: "production",
  meta: { flamaVersion: "2.1.0" },
};

const credential = { reveal: () => "test-only-vercel-token" };

describe("vercel deployment reader", () => {
  it("reads a deployment by URL over the documented endpoint", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return json(deployment);
    });

    const result = await new VercelRestDeploymentReader(credential, fetcher)
      .read("https://app-def456.vercel.app");

    expect(result).toEqual(deployment);
    expect(requests[0]?.url).toBe("https://api.vercel.com/v13/deployments/app-def456.vercel.app");
    expect(requests[0]?.init?.method).toBe("GET");
  });

  it("authorizes with a bearer token and never puts it in the path", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return json(deployment);
    });

    await new VercelRestDeploymentReader(credential, fetcher).read("app-def456.vercel.app");

    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-only-vercel-token");
    expect(requests[0]?.url).not.toContain("test-only-vercel-token");
  });

  it("scopes the read to a team when a slug is configured", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      requests.push(String(url));
      return json(deployment);
    });

    await new VercelRestDeploymentReader(credential, fetcher, "flama").read("app-def456.vercel.app");

    expect(requests[0]).toContain("slug=flama");
  });

  it("never follows a redirect", async () => {
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return json(deployment);
    });

    await new VercelRestDeploymentReader(credential, fetcher).read("app-def456.vercel.app");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a non-success response without surfacing its body", async () => {
    const fetcher = vi.fn(async () => json({ error: { message: "secret detail" } }, 403));

    await expect(new VercelRestDeploymentReader(credential, fetcher).read("app-def456.vercel.app"))
      .rejects.toThrow(/vercel deployment read failed/u);
  });

  it("rejects a response missing the fields verification depends on", async () => {
    const fetcher = vi.fn(async () => json({ url: "app.vercel.app", readyState: "READY" }));

    await expect(new VercelRestDeploymentReader(credential, fetcher).read("app-def456.vercel.app"))
      .rejects.toThrow();
  });

  it("accepts a preview deployment reporting a null target", async () => {
    const fetcher = vi.fn(async () => json({ ...deployment, target: null }));

    const result = await new VercelRestDeploymentReader(credential, fetcher).read("app.vercel.app");

    expect(result.target).toBeNull();
  });

  it("rejects meta values that are not strings", async () => {
    const fetcher = vi.fn(async () => json({ ...deployment, meta: { flamaVersion: 21 } }));

    await expect(new VercelRestDeploymentReader(credential, fetcher).read("app.vercel.app"))
      .rejects.toThrow();
  });

  it("rejects an identifier that would escape the endpoint path", async () => {
    const fetcher = vi.fn(async () => json(deployment));

    await expect(new VercelRestDeploymentReader(credential, fetcher).read("../v13/projects"))
      .rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
