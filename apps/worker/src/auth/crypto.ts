// Workers production limits PBKDF2 to 100,000 iterations. An independent
// server-side HMAC pepper also protects verifiers if the database is disclosed.
const ITERATIONS = 100_000;
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function equalSecrets(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

async function derive(password: string, pepper: string, salt: string): Promise<string> {
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const protectedPassword = await crypto.subtle.sign("HMAC", hmac, encoder.encode(password));
  const key = await crypto.subtle.importKey("raw", protectedPassword, "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: ITERATIONS, hash: "SHA-256" }, key, 256));
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = randomToken();
  return `pbkdf2-sha256$${ITERATIONS}$${salt}$${await derive(password, pepper, salt)}`;
}

export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  const [algorithm, count, salt, hash] = stored.split("$");
  if (algorithm !== "pbkdf2-sha256" || count !== String(ITERATIONS) || !salt || !hash) return false;
  return equalSecrets(await derive(password, pepper, salt), hash);
}
