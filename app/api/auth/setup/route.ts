import { authBody, authJson, authRoute, requireAuthConfig } from "@/lib/auth/http";
import { createOwner, sessionCookie } from "@/lib/auth/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return authRoute(async () => {
    const config = requireAuthConfig(request);
    const token = await createOwner(await authBody(request), config);
    return authJson({ authorized: true }, 201, { "Set-Cookie": sessionCookie(token, config) });
  });
}
