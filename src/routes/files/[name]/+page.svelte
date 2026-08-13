<script>
	import { formatBytes, formatCount, formatStat } from '$lib/format';

	let { data } = $props();
	const name = $derived(data.name);
	const profile = $derived(data.profile);
	const preview = $derived(data.preview);
	const profileError = $derived(profile?.error);
	const previewError = $derived(preview?.error);
</script>

<svelte:head>
	<title>parquet-peek — {name}</title>
</svelte:head>

<a class="back" href="/">← files</a>

<header class="file-head">
	<h1 class="file-name">{name}</h1>
	{#if profile?.rowCount !== undefined}
		<div class="file-meta">
			<span class="meta"><strong>{formatBytes(profile.sizeBytes ?? null)}</strong></span>
			<span class="meta"><strong>{formatCount(profile.rowCount)}</strong> rows</span>
			{#if profile?.sampled}
				<span class="badge">profiled from sample</span>
			{/if}
		</div>
	{/if}
</header>

{#if profileError}
	<div class="alert">{profileError}</div>
{/if}

{#if profile?.columns}
	<section class="panel">
		<h2>Schema</h2>
		<div class="scroll">
			<table>
				<thead>
					<tr><th>column</th><th>type</th></tr>
				</thead>
				<tbody>
					{#each profile.columns as col (col.name)}
						<tr>
							<td class="mono">{col.name}</td>
							<td class="type">{col.type}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="panel">
		<h2>Profile</h2>
		<div class="scroll">
			<table>
				<thead>
					<tr>
						<th>column</th>
						<th>null %</th>
						<th>min</th>
						<th>max</th>
						<th>≈ distinct</th>
					</tr>
				</thead>
				<tbody>
					{#each profile.columns as col (col.name)}
						<tr>
							<td class="mono">{col.name}</td>
							<td class="num">{col.nullPct}%</td>
							<td class="mono dim">{formatStat(col.min)}</td>
							<td class="mono dim">{formatStat(col.max)}</td>
							<td class="num">{formatCount(col.distinctApprox)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			null counts &amp; min/max from footer metadata (instant); distinct is approx_count_distinct
			{#if profile.sampled}
				over a {formatCount(profile.columns[0]?.sampleN || 0)}-row sample
			{/if}.
		</p>
	</section>
{/if}

<section class="panel">
	<h2>Preview — first {preview?.rows?.length ?? 0} rows</h2>
	{#if previewError}
		<div class="alert">{previewError}</div>
	{:else if preview?.rows}
		<div class="scroll">
			<table>
				<thead>
					<tr>
						{#each preview.columns as c (c)}
							<th class="mono">{c}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each preview.rows as row, i (i)}
						<tr>
							{#each row as cell, j (j)}
								<td class="mono dim">{cell === null ? '∅' : String(cell)}</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.back {
		display: inline-block;
		margin: 12px 0;
		font-size: 13px;
		color: #5eead4;
	}

	.file-head {
		margin-bottom: 18px;
	}

	.file-name {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 18px;
		font-weight: 700;
		color: #f1f5f9;
		margin: 0 0 10px;
		word-break: break-all;
	}

	.file-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 14px;
		font-size: 13px;
		color: #94a3b8;
	}

	.meta strong {
		color: #e2e8f0;
	}

	.badge {
		background: #134e4a;
		color: #5eead4;
		font-size: 11px;
		font-weight: 600;
		padding: 3px 8px;
		border-radius: 999px;
	}

	.panel {
		background: #111827;
		border: 1px solid #1e293b;
		border-radius: 14px;
		padding: 14px 16px;
		margin-bottom: 16px;
	}

	.panel h2 {
		font-size: 13px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #94a3b8;
		margin: 0 0 10px;
	}

	.scroll {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}

	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 12px;
	}

	.type {
		color: #a5b4fc;
		font-size: 12px;
	}

	.num {
		text-align: right;
		color: #e2e8f0;
	}

	.dim {
		color: #cbd5e1;
	}

	.note {
		margin: 10px 0 0;
		font-size: 11px;
		color: #64748b;
	}

	.alert {
		background: #451a1a;
		border: 1px solid #7f1d1d;
		color: #fca5a5;
		border-radius: 10px;
		padding: 12px 14px;
		font-size: 13px;
		margin-bottom: 16px;
	}
</style>
