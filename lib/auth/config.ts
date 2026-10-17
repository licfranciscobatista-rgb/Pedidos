export type AuthConfiguration = {
  ownerUsername: string;
  normalizedUsername: string;
  dataOwnerId: string;
  appOrigin: string;
  production: boolean;
  setupToken: string;
};
export type AppUser = { userId: string; username: string; displayName: string };
export type Environment = Record<string, string | undefined>;

export function normalizeUsername(value: string): string { return value.trim().toLowerCase(); }

// No request header is an identity source in the standalone application.
export function authConfiguration(environment: Environment): AuthConfiguration | null {
  const ownerUsername = environment.APP_OWNER_USERNAME?.trim() ?? "";
  const normalizedUsername = normalizeUsername(ownerUsername);
  const dataOwnerId = environment.APP_DATA_OWNER_ID?.trim().toLowerCase() ?? "";
  const production = environment.NODE_ENV === "production";
  const setupToken = environment.APP_SETUP_TOKEN ?? "";
  if (!/^[a-z0-9._-]{3,40}$/.test(normalizedUsername)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dataOwnerId)) return null;
  let appOrigin: string;
  try {
    const url = new URL(environment.APP_ORIGIN?.trim() ?? "");
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && !production && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
    appOrigin = url.origin;
  } catch { return null; }
  return { ownerUsername, normalizedUsername, dataOwnerId, appOrigin, production, setupToken };
}

export function sessionCookieName(production: boolean): string {
  return production ? "__Host-mi_encargo_session" : "mi_encargo_session";
}
