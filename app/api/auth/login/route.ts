import { authBody, authJson, authRoute, requireAuthConfig } from "@/lib/auth/http";
import { sessionCookie, signIn } from "@/lib/auth/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return authRoute(async () => {
    const config = requireAuthConfig(request);
    const token = await signIn(await authBody(request), config);
    return authJson({ authorized: true }, 200, { "Set-Cookie": sessionCookie(token, config) });
  });
}
