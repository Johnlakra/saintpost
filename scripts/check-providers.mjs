// Usage: npm run check:providers   (reads keys from .env). Sends one tiny real request to each configured image provider.
import 'dotenv/config';
const { testImageProviders, cloudflareBudget } = await import('../dist/providers/image/index.js');
console.log('Testing configured image providers (tiny 512x512 request each)...\n');
const results = await testImageProviders();
if (!results.length) {
  console.log('No good provider configured. Set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (free) first.');
  process.exit(1);
}
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.label}: ${r.detail}`);
console.log(`\nCloudflare estimate used in this test: ${cloudflareBudget().used} neurons`);
process.exit(results.some(r => r.ok) ? 0 : 1);
