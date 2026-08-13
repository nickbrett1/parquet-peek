/** Parallel-load profile (footer stats + sampled distinct) and 20-row preview. */
export async function load({ params, fetch }) {
  const name = decodeURIComponent(params.name);
  const [profileRes, previewRes] = await Promise.all([
    fetch(`/api/profile?file=${encodeURIComponent(name)}`),
    fetch(`/api/preview?file=${encodeURIComponent(name)}&limit=20`),
  ]);
  const profile = profileRes.ok
    ? await profileRes.json()
    : { error: (await profileRes.json().catch(() => ({}))).error };
  const preview = previewRes.ok
    ? await previewRes.json()
    : { error: (await previewRes.json().catch(() => ({}))).error };
  return { name, profile, preview };
}
