import { json } from "@sveltejs/kit";
import { store } from "$lib/server/parquet-store";

/** GET /api/files — instant footer-only manifest for every *.parquet file. */
export async function GET() {
  try {
    return json(await store.listFiles());
  } catch (err) {
    return json({ error: err.message }, { status: err.status || 500 });
  }
}
