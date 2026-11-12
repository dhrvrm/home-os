// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildServiceWorker } from "./build-service-worker.mjs";

let output;
beforeEach(async () => {
  output = await mkdtemp(path.join(os.tmpdir(), "home-os-pwa-generator-"));
  const files = {
    "index.html": "<html>Home OS</html>",
    "manifest.webmanifest": "{}",
    "icon.svg": "<svg/>",
    "icons/icon-192.png": "png192",
    "icons/icon-512.png": "png512",
    "icons/maskable-512.png": "maskable",
    "icons/apple-touch-icon.png": "apple",
    "_next/static/chunks/app.js": "console.log('app')",
    "_next/static/chunks/app.css": "body{}",
    "_next/static/media/font.woff2": "font",
    "_next/static/chunks/app.js.map": "source-map",
    "vendor/wllama.wasm": "optional-wasm",
    "vendor/wllama-compat.wasm": "optional-compat-wasm",
    "vendor/wllama-compat.js": "optional-worker",
    "api/v1/private.json": "private",
    "model.gguf": "never-precache",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(output, file)), { recursive: true });
    await writeFile(path.join(output, file), content);
  }
});
afterEach(async () => { await rm(output, { recursive: true, force: true }); });

async function generatedBuild() {
  await buildServiceWorker(output);
  const source = await readFile(path.join(output, "sw.js"), "utf8");
  const declaration = source.match(/^const BUILD = (.*);$/m);
  if (!declaration) throw new Error("Generated build declaration is absent");
  return { source, build: JSON.parse(declaration[1]) };
}

describe("service worker production generation", () => {
  it("discovers the complete small shell while excluding optional runtimes and private data", async () => {
    const { source, build } = await generatedBuild();
    expect(build.assets).toEqual(expect.arrayContaining(["/", "/manifest.webmanifest", "/_next/static/chunks/app.js", "/_next/static/chunks/app.css", "/_next/static/media/font.woff2"]));
    expect(build.assets.some((asset) => /vendor|\/api\/|gguf|\.map$/.test(asset))).toBe(false);
    expect(build.version).toMatch(/^[a-f0-9]{20}$/);
    const events = new Map();
    vm.runInNewContext(source, { self: { addEventListener: (name, handler) => events.set(name, handler) } });
    expect(events.has("install")).toBe(true);
  });

  it("uses a stable version for identical content and changes it when an actual shell asset changes", async () => {
    const first = await generatedBuild();
    expect((await generatedBuild()).build.version).toBe(first.build.version);
    await writeFile(path.join(output, "_next/static/chunks/app.js"), "console.log('new app')");
    expect((await generatedBuild()).build.version).not.toBe(first.build.version);
  });
});
