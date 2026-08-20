<script>
	import { formatBytes, formatCount, formatStat } from '$lib/format';
	import { decodeFilename } from '$lib/dictionary';

	let { data } = $props();
	const files = $derived((data.files ?? []).map((f) => ({ ...f, decoded: decodeFilename(f.name) })));
</script>

<svelte:head>
	<title>parquet-peek — files</title>
</svelte:head>

{#if files.length === 0}
	<div class="empty">
		<p class="empty-title">No parquet files found</p>
		<p class="empty-sub">Checked <code>{@html ''}</code></p>
	</div>
{:else}
	<ul class="cards">
		{#each files as f (f.name)}
			<li>
				<a class="card" href={`/files/${encodeURIComponent(f.name)}`}>
					<div class="card-head">
						<span class="card-name">{f.name}</span>
						<span class="card-size">{formatBytes(f.sizeBytes)}</span>
					</div>
					<div class="card-stats">
						<span class="stat"><strong>{formatCount(f.rowCount)}</strong> rows</span>
						<span class="dot" aria-hidden="true"></span>
						<span class="stat"><strong>{f.numColumns}</strong> cols</span>
						<span class="dot" aria-hidden="true"></span>
						<span class="stat"><strong>{f.numRowGroups}</strong> groups</span>
					</div>
					{#if f.decoded.matched}
						<p class="card-decode">{f.decoded.summary}</p>
					{/if}
					{#if f.minTs !== null && f.maxTs !== null}
						<div class="card-ts">
							<span class="ts">{formatStat(f.minTs)}</span>
							<span class="arrow" aria-hidden="true">→</span>
							<span class="ts">{formatStat(f.maxTs)}</span>
						</div>
					{/if}
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.empty {
		text-align: center;
		padding: 80px 20px;
		color: #94a3b8;
	}

	.empty-title {
		font-size: 17px;
		font-weight: 600;
		color: #e2e8f0;
		margin: 0 0 6px;
	}

	.empty-sub {
		font-size: 13px;
		margin: 0;
	}

	.empty-sub code {
		background: #1e293b;
		padding: 2px 6px;
		border-radius: 6px;
		font-size: 12px;
	}

	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.card {
		display: block;
		background: #111827;
		border: 1px solid #1e293b;
		border-radius: 14px;
		padding: 14px 16px;
		color: inherit;
		transition:
			border-color 0.15s ease,
			transform 0.15s ease;
	}

	.card:active {
		transform: scale(0.985);
	}

	.card:hover {
		border-color: #334155;
	}

	.card-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		margin-bottom: 8px;
	}

	.card-name {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 14px;
		font-weight: 600;
		color: #f1f5f9;
		word-break: break-all;
	}

	.card-size {
		font-size: 12px;
		color: #34d399;
		font-weight: 600;
		white-space: nowrap;
	}

	.card-stats {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: #94a3b8;
	}

	.stat strong {
		color: #e2e8f0;
	}

	.dot {
		width: 3px;
		height: 3px;
		border-radius: 50%;
		background: #475569;
	}

	.card-ts {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 11px;
		color: #64748b;
	}

	.card-decode {
		margin: 8px 0 0;
		font-size: 12px;
		line-height: 1.45;
		color: #94a3b8;
	}

	.arrow {
		color: #475569;
	}
</style>
