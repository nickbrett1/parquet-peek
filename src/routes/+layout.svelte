<script>
	let { children } = $props();
</script>

<svelte:head>
	<title>parquet-peek</title>
	<meta name="description" content="Peek before deep dive — row counts, schema, profiles and previews for parquet files." />
</svelte:head>

<div class="app">
	<header class="topbar">
		<a class="brand" href="/" aria-label="parquet-peek home">
			<span class="brand-mark" aria-hidden="true">▮▮▮▮</span>
			<span class="brand-name">parquet-peek</span>
		</a>
	</header>
	<main class="content">{@render children()}</main>
	<footer class="foot">read-only · tailnet only · no auth</footer>
</div>

<style>
	:global(*) {
		box-sizing: border-box;
	}

	:global(html) {
		-webkit-text-size-adjust: 100%;
	}

	:global(body) {
		margin: 0;
		background: #0b1020;
		color: #e2e8f0;
		font-family:
			-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		-webkit-font-smoothing: antialiased;
		min-height: 100dvh;
	}

	:global(a) {
		color: #5eead4;
		text-decoration: none;
	}

	:global(table) {
		border-collapse: collapse;
		width: 100%;
	}

	:global(th, td) {
		text-align: left;
		padding: 8px 10px;
		border-bottom: 1px solid #1e293b;
		font-size: 13px;
		white-space: nowrap;
	}

	:global(th) {
		color: #94a3b8;
		font-weight: 600;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.app {
		max-width: 720px;
		margin: 0 auto;
		padding: 0 16px 48px;
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}

	.topbar {
		position: sticky;
		top: 0;
		z-index: 10;
		background: rgba(11, 16, 32, 0.92);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		padding: 14px 2px;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: #e2e8f0;
	}

	.brand-mark {
		color: #34d399;
		font-size: 14px;
		letter-spacing: 1px;
	}

	.brand-name {
		font-weight: 700;
		font-size: 17px;
		letter-spacing: -0.01em;
	}

	.content {
		flex: 1;
	}

	.foot {
		margin-top: 40px;
		padding-top: 16px;
		border-top: 1px solid #1e293b;
		color: #475569;
		font-size: 11px;
		text-align: center;
	}
</style>
