/** Refuse startup if env looks like it stores signing material (keyless architecture). */
const FORBIDDEN_KEY_PATTERN =
  /(PRIVATE|SECRET).*KEY|MNEMONIC|SEED.?PHRASE|KEYPAIR|WALLET_SECRET|SIGNING_KEY/i;

export function assertKeylessEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new Error(`Forbidden environment variable "${key}": backend must not store signing keys`);
    }
  }
}

export function assertProductionOrigins(frontendOrigin: string, extraOrigins: string[]): void {
  if (process.env.NODE_ENV !== "production") return;
  const origins = [frontendOrigin, ...extraOrigins];
  for (const origin of origins) {
    if (!origin.startsWith("https://")) {
      throw new Error(`Production origin must use https:// (${origin})`);
    }
  }
}