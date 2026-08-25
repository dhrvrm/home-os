import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, "..");
const destinationDirectory = resolve(webDirectory, "public/vendor");

await mkdir(destinationDirectory, { recursive: true });
await Promise.all([
  copyFile(resolve(webDirectory, "../../node_modules/@wllama/wllama/esm/wasm/wllama.wasm"), resolve(destinationDirectory, "wllama.wasm")),
  copyFile(resolve(webDirectory, "../../node_modules/@wllama/wllama-compat/wasm/wllama.js"), resolve(destinationDirectory, "wllama-compat.js")),
  copyFile(resolve(webDirectory, "../../node_modules/@wllama/wllama-compat/wasm/wllama.wasm"), resolve(destinationDirectory, "wllama-compat.wasm")),
]);
