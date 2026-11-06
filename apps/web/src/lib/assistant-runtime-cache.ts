import webPackage from "../../package.json";

const runtimeVersion = `${webPackage.dependencies["@wllama/wllama"]}-${webPackage.dependencies["@wllama/wllama-compat"]}`;
const versionQuery = `?v=${encodeURIComponent(runtimeVersion)}`;
export const assistantRuntimePaths = {
  wasm: `/vendor/wllama.wasm${versionQuery}`,
  compatWorker: `/vendor/wllama-compat.js${versionQuery}`,
  compatWasm: `/vendor/wllama-compat.wasm${versionQuery}`,
};

// Called by the real runtime factory only after optional-model consent. Core
// inventory installation never waits for or downloads these large assets.
export async function prepareAssistantRuntimeCache(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  const active = registration.active ?? (await navigator.serviceWorker.ready).active;
  if (!active) return;
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      if (error) reject(error); else resolve();
    };
    const timeout = setTimeout(() => finish(new Error("The assistant runtime could not be saved for offline use. Reconnect and try again.")), 120_000);
    channel.port1.onmessage = (event) => finish(event.data?.ok ? undefined : new Error(event.data?.reason === "update-required"
      ? "Reload Home OS before loading the local assistant."
      : "The assistant runtime could not be saved for offline use. Check your connection and browser storage, then retry."));
    try { active.postMessage({ type: "HOMEOS_CACHE_ASSISTANT_RUNTIME", version: runtimeVersion }, [channel.port2]); }
    catch { finish(new Error("The assistant runtime cache is unavailable. Reopen Home OS while connected and retry.")); }
  });
}
