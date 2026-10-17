import { cookies } from "next/headers";
import { sessionCookieName } from "@/lib/auth/config";
import { authJson, authRoute, requireAuthConfig } from "@/lib/auth/http";
import { sessionCookie, signOut } from "@/lib/auth/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return authRoute(async () => {
    const config = requireAuthConfig(request);
    const token = (await cookies()).get(sessionCookieName(config.production))?.value;
    await signOut(token);
    return authJson({ authorized: false }, 200, { "Set-Cookie": sessionCookie("", config, true) });
  });
}
