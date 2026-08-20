<script>
	import { formatBytes, formatCount, formatStat, formatPct, formatPrice } from '$lib/format';
	import { decodeFilename } from '$lib/dictionary';

	let { data } = $props();
	const name = $derived(data.name);
	const profile = $derived(data.profile);
	const preview = $derived(data.preview);
	const highlights = $derived(data.highlights);
	const decoded = $derived(decodeFilename(name));
	const profileError = $derived(profile?.error);
	const previewError = $derived(preview?.error);
	const highlightsError = $derived(highlights?.error);

	const roleBadge = (role) => `badge badge-${role}`;

	/** One-line, role-appropriate summary of a column's stats. */
	function colStatsText(col) {
		const nullTxt = col.nullPct > 0 ? `null ${formatPct(col.nullPct)}` : null;
		switch (col.role) {
			case 'category':
			case 'symbol':
				return [
					col.top?.length
						? col.top.map((t) => `${t.value ?? '∅'} ${formatPct(t.pct)}`).join(' · ')
						: null,
					col.distinctApprox > 0 ? `≈${formatCount(col.distinctApprox)} values` : null,
					nullTxt,
				]
					.filter(Boolean)
					.join(' · ') || '—';
			case 'price':
				return [
					`min ${formatStat(col.min)}`,
					col.median !== null && col.median !== undefined ? `med ${formatPrice(col.median)}` : null,
					`max ${formatStat(col.max)}`,
					nullTxt,
				]
					.filter(Boolean)
					.join(' · ') || '—';
			case 'size':
				return [`min ${formatStat(col.min)}`, `max ${formatStat(col.max)}`, nullTxt]
					.filter(Boolean)
					.join(' · ') || '—';
			case 'id':
				return [`≈${formatCount(col.distinctApprox)} unique`, nullTxt].filter(Boolean).join(' · ') || '—';
			case 'timestamp':
				return [`${formatStat(col.min)} → ${formatStat(col.max)}`, nullTxt].filter(Boolean).join(' · ') || '—';
			default:
				return [`${formatStat(col.min)} → ${formatStat(col.max)}`, `≈${formatCount(col.distinctApprox)}`, nullTxt]
					.filter(Boolean)
					.join(' · ') || '—';
		}
	}
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
				<span class="badge badge-note">profiled from sample</span>
			{/if}
		</div>
	{/if}
</header>

{#if profileError}
	<div class="alert">{profileError}</div>
{/if}

{#if decoded.matched}
	<section class="panel">
		<h2>What is this file?</h2>
		<p class="decode-summary">{decoded.summary}</p>
		{#if decoded.venue || decoded.protocol || decoded.dataset || decoded.date}
			<div class="chips">
				{#if decoded.venue}
					<span class="chip">{decoded.venue.name}</span>
				{/if}
				{#if decoded.protocol}
					<span class="chip">{decoded.protocol.name}</span>
				{/if}
				{#if decoded.dataset}
					<span class="chip">{decoded.dataset.name}</span>
				{/if}
				{#if decoded.date}
					<span class="chip chip-dim">{decoded.date}</span>
				{/if}
			</div>
		{/if}
	</section>
{/if}

{#if highlightsError}
	<div class="alert">Highlights failed: {highlightsError}</div>
{:else if highlights?.bullets?.length}
	<section class="panel panel-accent">
		<h2>TL;DR — what's interesting</h2>
		<ul class="bullets">
			{#each highlights.bullets as b (b)}
				<li>{b}</li>
			{/each}
		</ul>
		{#if highlights.sampled}
			<p class="note">Based on a {formatCount(highlights.sampleN)}-row sample of {formatCount(highlights.rowCount)} rows — good for direction, not exact numbers.</p>
		{/if}
	</section>

	<section class="panel">
		<h2>Questions worth taking to your notebook</h2>
		<ul class="bullets bullets-q">
			{#each highlights.questions as q (q)}
				<li>{q}</li>
			{/each}
		</ul>
	</section>
{/if}

{#if profile?.columns}
	<section class="panel">
		<h2>Schema — what each column means</h2>
		<div class="scroll">
			<table>
				<thead>
					<tr><th>column</th><th>type</th><th>meaning</th></tr>
				</thead>
				<tbody>
					{#each profile.columns as col (col.name)}
						<tr>
							<td class="mono">
								{col.name}
								{#if col.role}
									<span class={roleBadge(col.role)}>{col.role}</span>
								{/if}
							</td>
							<td class="type">{col.type}</td>
							<td class="dim">
								{#if col.meaning}
									{col.meaning}{#if col.unit} <span class="unit">({col.unit})</span>{/if}
								{:else}
									<span class="unknown">no known meaning — infer from the stats</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="panel">
		<h2>Column stats</h2>
		<div class="scroll">
			<table>
				<thead>
					<tr><th>column</th><th>stats</th></tr>
				</thead>
				<tbody>
					{#each profile.columns as col (col.name)}
						<tr>
							<td class="mono">{col.name}</td>
							<td class="dim">{colStatsText(col)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			null &amp; min/max from footer metadata (instant); distinct ≈ approx_count_distinct
			{#if profile.sampled}
				over a {formatCount(profile.columns[0]?.sampleN || 0)}-row sample
			{/if}. Category columns show the top values with % instead of min/max; id columns show cardinality.
		</p>
	</section>
{/if}

<section class="panel">
	{#if previewError}
		<div class="alert">{previewError}</div>
	{:else if preview?.rows}
		<details>
			<summary class="preview-summary">Preview — first {preview.rows.length} rows</summary>
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
		</details>
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

	.panel {
		background: #111827;
		border: 1px solid #1e293b;
		border-radius: 14px;
		padding: 14px 16px;
		margin-bottom: 16px;
	}

	.panel-accent {
		border-color: #134e4a;
	}

	.panel h2 {
		font-size: 13px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #94a3b8;
		margin: 0 0 10px;
	}

	.decode-summary {
		margin: 0 0 10px;
		font-size: 14px;
		line-height: 1.55;
		color: #e2e8f0;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.chip {
		background: #1e293b;
		border: 1px solid #334155;
		color: #cbd5e1;
		font-size: 11px;
		font-weight: 600;
		padding: 3px 9px;
		border-radius: 999px;
	}

	.chip-dim {
		color: #64748b;
	}

	.bullets {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.bullets li {
		position: relative;
		padding-left: 16px;
		font-size: 13.5px;
		line-height: 1.5;
		color: #e2e8f0;
	}

	.bullets li::before {
		content: '▸';
		position: absolute;
		left: 0;
		color: #34d399;
	}

	.bullets-q li::before {
		content: '?';
		color: #fbbf24;
		font-weight: 700;
	}

	.badge {
		display: inline-block;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 6px;
		border-radius: 999px;
		margin-left: 6px;
		vertical-align: 1px;
	}

	.badge-note {
		background: #134e4a;
		color: #5eead4;
		margin-left: 0;
	}

	.badge-timestamp {
		background: #0c4a6e;
		color: #7dd3fc;
	}

	.badge-price {
		background: #064e3b;
		color: #6ee7b7;
	}

	.badge-size {
		background: #4c1d95;
		color: #c4b5fd;
	}

	.badge-id {
		background: #78350f;
		color: #fcd34d;
	}

	.badge-category {
		background: #831843;
		color: #f9a8d4;
	}

	.badge-symbol {
		background: #134e4a;
		color: #5eead4;
	}

	.badge-numeric,
	.badge-text,
	.badge-other {
		background: #1e293b;
		color: #94a3b8;
	}

	.scroll {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}

	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 12px;
		white-space: nowrap;
	}

	.type {
		color: #a5b4fc;
		font-size: 12px;
	}

	.unit {
		color: #64748b;
		font-size: 11px;
	}

	.unknown {
		color: #64748b;
		font-style: italic;
		font-size: 12px;
	}

	.dim {
		color: #cbd5e1;
		font-size: 12px;
	}

	.note {
		margin: 10px 0 0;
		font-size: 11px;
		color: #64748b;
		line-height: 1.5;
	}

	.preview-summary {
		font-size: 13px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #94a3b8;
		cursor: pointer;
		padding: 2px 0;
		user-select: none;
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
