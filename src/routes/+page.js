/** GET /api/files — instant footer-only manifest (no data scan). */
export async function load({ fetch }) {
  const res = await fetch("/api/files");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `failed to list files (${res.status})`);
  }
  return await res.json();
}
