import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : target;
  }))).flat();
}

export async function buildServiceWorker(output = path.join(webRoot, "out")) {
  const webPackage = JSON.parse(await readFile(path.join(webRoot, "package.json"), "utf8"));
  const runtimeVersion = `${webPackage.dependencies["@wllama/wllama"]}-${webPackage.dependencies["@wllama/wllama-compat"]}`;
  const shell = ["/", "/manifest.webmanifest", "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"];
  const chunks = (await walk(path.join(output, "_next", "static")))
    .filter((file) => /\.(?:js|css|woff2?)$/.test(file))
    .map((file) => `/${path.relative(output, file).split(path.sep).join("/")}`)
    .sort();
  const assets = [...shell, ...chunks];
  const hash = createHash("sha256");
  const template = await readFile(path.join(webRoot, "public", "sw.js"), "utf8");
  hash.update(template);
  for (const asset of assets) {
    hash.update(asset);
    hash.update(await readFile(path.join(output, asset === "/" ? "index.html" : asset.slice(1))));
  }
  const version = hash.digest("hex").slice(0, 20);
  const declaration = `const BUILD = ${JSON.stringify({ version, runtimeVersion, assets })};`;
  const source = template.replace(/^const BUILD = .*;$/m, declaration);
  if (source === template) throw new Error("Service worker build declaration is missing.");
  await writeFile(path.join(output, "sw.js"), source);
  console.log(`[pwa] Precache ${assets.length} shell assets (${version})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildServiceWorker();
