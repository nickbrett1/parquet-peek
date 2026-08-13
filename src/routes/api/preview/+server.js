import { json } from "@sveltejs/kit";
import { store } from "$lib/server/parquet-store";

/** GET /api/preview?file=<name>&limit=<n> — first rows via LIMIT pushdown. */
export async function GET({ url }) {
  try {
    return json(
      await store.getPreview(
        url.searchParams.get("file"),
        url.searchParams.get("limit") || "20",
      ),
    );
  } catch (err) {
    return json({ error: err.message }, { status: err.status || 500 });
  }
}
