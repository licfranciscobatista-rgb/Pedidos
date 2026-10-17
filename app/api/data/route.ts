import { context, json, readData, route } from "../_shared";

export async function GET(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request);
    return json(await readData(db, ownerId));
  });
}
