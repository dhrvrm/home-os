import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker health", () => {
  it("serves the API health contract", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request("https://home-os.test/healthz"), env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { status: "ok" }, error: null });
  });
});
