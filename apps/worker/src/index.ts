import { Hono } from "hono";
import type { Env } from "./env";

interface Envelope<T> {
  data: T | null;
  error: { code: string; message: string; field?: string } | null;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (context) =>
  context.json<Envelope<{ status: "ok" }>>({
    data: { status: "ok" },
    error: null,
  }),
);

app.get("/readyz", async (context) => {
  try {
    await context.env.DB.prepare("SELECT 1 AS ready").first();
    return context.json<Envelope<{ status: "ready" }>>({
      data: { status: "ready" },
      error: null,
    });
  } catch {
    return context.json<Envelope<never>>(
      {
        data: null,
        error: { code: "not_ready", message: "Home OS storage is unavailable." },
      },
      503,
    );
  }
});

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export { app };
export default app;
