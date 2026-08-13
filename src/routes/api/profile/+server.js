import { json } from "@sveltejs/kit";
import { store } from "$lib/server/parquet-store";

/** GET /api/profile?file=<name> — footer stats + sampled approx distinct (cached). */
export async function GET({ url }) {
  try {
    return json(await store.getProfile(url.searchParams.get("file")));
  } catch (err) {
    return json({ error: err.message }, { status: err.status || 500 });
  }
}
