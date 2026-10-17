export async function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
