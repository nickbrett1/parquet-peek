import { json } from "@sveltejs/kit";
import { store } from "$lib/server/parquet-store";

/** GET /api/highlights?file=<name> — plain-language TL;DR bullets + notebook questions (sampled, cached). */
export async function GET({ url }) {
  try {
    return json(await store.getHighlights(url.searchParams.get("file")));
  } catch (err) {
    return json({ error: err.message }, { status: err.status || 500 });
  }
}
