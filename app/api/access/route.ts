import { getAppUser } from "@/app/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAppUser();
  return Response.json({ authorized: Boolean(user) }, { status: user ? 200 : 401, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
