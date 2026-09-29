// Daily run by GitHub Actions: find products we haven't seen before, record them, push a notification.
import fs from 'node:fs';
import webpush from 'web-push';

const BRANDS = [
  { name: 'The Ragged Priest', shopify: 'https://theraggedpriest.com' },
  { name: 'Damson Madder', shopify: 'https://damsonmadder.com' },
  { name: 'Lucy & Yak', shopify: 'https://lucyandyak.com' },
  // ponytail: Cloudflare bot wall blocks this from servers; shows as "couldn't check" until they relax it
  { name: 'Peachy Den', shopify: 'https://www.peachyden.co.uk' },
  { name: 'Dr. Martens', sitemap: 'https://www.drmartens.com/uk/en_gb/sitemap/products.xml' },
  { name: 'SKIMS', sitemap: 'https://skims.com/sitemap-products.xml' },
];
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' };

async function get(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function fetchShopify(base) {
  const items = [];
  for (let page = 1; page <= 40; page++) {
    const { products } = await (await get(`${base}/products.json?limit=250&page=${page}`)).json();
    if (!products.length) break;
    for (const p of products) items.push({
      id: String(p.id),
      title: p.title,
      url: `${base}/products/${p.handle}`,
      image: p.images[0]?.src,
      price: p.variants[0]?.price,
    });
  }
  return items;
}

async function fetchSitemap(url) {
  const xml = await (await get(url)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, u]) => {
    const slug = u.includes('/p/') ? u.split('/').at(-3) : u.split('/').at(-1);
    return { id: u, url: u, title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) };
  });
}

const seen = fs.existsSync('seen.json') ? JSON.parse(fs.readFileSync('seen.json')) : {};
const feed = fs.existsSync('drops.json') ? JSON.parse(fs.readFileSync('drops.json')) : { drops: [] };
const now = new Date().toISOString();
const status = {};
const fresh = [];

for (const b of BRANDS) {
  try {
    const items = b.shopify ? await fetchShopify(b.shopify) : await fetchSitemap(b.sitemap);
    if (!items.length) throw new Error('no products found');
    const known = new Set(seen[b.name] || []);
    // First run for a brand just seeds the list, otherwise everything would look "new".
    if (known.size) for (const it of items) if (!known.has(it.id)) fresh.push({ brand: b.name, found: now, ...it });
    seen[b.name] = [...new Set([...known, ...items.map(i => i.id)])];
    status[b.name] = { ok: true, count: items.length };
  } catch (e) {
    status[b.name] = { ok: false, error: e.message };
  }
  console.log(b.name, status[b.name]);
}

feed.checked = now;
feed.status = status;
feed.drops = [...fresh, ...feed.drops].slice(0, 300);
fs.writeFileSync('seen.json', JSON.stringify(seen));
fs.writeFileSync('drops.json', JSON.stringify(feed, null, 1));
console.log(`${fresh.length} new`);

const { PUSH_SUBSCRIPTION, VAPID_PUBLIC, VAPID_PRIVATE } = process.env;
if (fresh.length && PUSH_SUBSCRIPTION && VAPID_PRIVATE) {
  const counts = {};
  for (const f of fresh) counts[f.brand] = (counts[f.brand] || 0) + 1;
  webpush.setVapidDetails('mailto:drops@example.com', VAPID_PUBLIC, VAPID_PRIVATE);
  await webpush.sendNotification(JSON.parse(PUSH_SUBSCRIPTION), JSON.stringify({
    title: `${fresh.length} new drop${fresh.length > 1 ? 's' : ''}`,
    body: Object.entries(counts).map(([b, n]) => `${b}: ${n}`).join(' · '),
  }));
}
