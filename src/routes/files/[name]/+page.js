/** Parallel-load profile (footer stats + sampled distinct), 20-row preview, and TL;DR highlights. */
export async function load({ params, fetch }) {
  const name = decodeURIComponent(params.name);
  const q = encodeURIComponent(name);
  const [profileRes, previewRes, highlightsRes] = await Promise.all([
    fetch(`/api/profile?file=${q}`),
    fetch(`/api/preview?file=${q}&limit=20`),
    fetch(`/api/highlights?file=${q}`),
  ]);
  const profile = profileRes.ok
    ? await profileRes.json()
    : { error: (await profileRes.json().catch(() => ({}))).error };
  const preview = previewRes.ok
    ? await previewRes.json()
    : { error: (await previewRes.json().catch(() => ({}))).error };
  const highlights = highlightsRes.ok
    ? await highlightsRes.json()
    : { error: (await highlightsRes.json().catch(() => ({}))).error };
  return { name, profile, preview, highlights };
}
