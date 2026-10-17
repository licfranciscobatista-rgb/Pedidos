import { cookies } from "next/headers";
import { authConfiguration, sessionCookieName, type AppUser } from "@/lib/auth/config";
import { readSession } from "@/lib/auth/session";

export type { AppUser } from "@/lib/auth/config";

export async function getAppUser(): Promise<AppUser | null> {
  const config = authConfiguration(process.env);
  if (!config) return null;
  try {
    const token = (await cookies()).get(sessionCookieName(config.production))?.value;
    if (!token) return null;
    return await readSession(token, config);
  } catch {
    // Authentication outages must never become a bypass to private orders.
    return null;
  }
}
