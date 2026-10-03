// Daily run by GitHub Actions: find products we haven't seen before, record them, push a notification.
import fs from 'node:fs';
import webpush from 'web-push';

const BRANDS = [
  { name: 'The Ragged Priest', shopify: 'https://theraggedpriest.com', vinted: 46993 },
  { name: 'Damson Madder', shopify: 'https://damsonmadder.com', vinted: 3997864 },
  { name: 'Lucy & Yak', shopify: 'https://lucyandyak.com', vinted: 1042718 },
  // ponytail: Cloudflare bot wall blocks the shop from servers; shows as "couldn't check" until they relax it
  { name: 'Peachy Den', shopify: 'https://www.peachyden.co.uk', vinted: 4394528 },
  { name: 'Dr. Martens', sitemap: 'https://www.drmartens.com/uk/en_gb/sitemap/products.xml', vinted: 309 },
  { name: 'SKIMS', sitemap: 'https://skims.com/sitemap-products.xml', vinted: 590677 },
  // No shop of their own that sells clothes (JPG's site is perfume only), so Vinted only.
  { name: 'Galliano', vinted: [10613, 7011975] },
  { name: 'Jean Paul Gaultier', vinted: 4129 },
  { name: 'Marine Serre', next: ['https://www.marineserre.com/en/collection/new-in-women', 'https://www.marineserre.com/en/collection/new-in-men'], cur: '€', vinted: 780179 },
  { name: 'Moschino', shopify: 'https://www.moschino.com', cur: '€', vinted: 11925 },
  { name: 'KNWLS', shopify: 'https://knwls.com', vinted: 6490707 },
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

// Marine Serre's shop is a Next.js front end; each collection page embeds its products as JSON.
async function fetchNext(urls) {
  const items = [];
  for (const url of urls) {
    const html = await (await get(url)).text();
    const json = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)?.[1];
    if (!json) throw new Error('page layout changed');
    for (const p of JSON.parse(json).props.pageProps.collection.products) items.push({
      id: p.id,
      title: p.title.charAt(0) + p.title.slice(1).toLowerCase(),
      url: `${new URL(url).origin}/en/products/${p.handle}`,
      image: p.images[0]?.url,
      price: Number(p.priceRange.minVariantPrice.amount).toFixed(2),
    });
  }
  return items;
}

// Vinted has no public API; its catalog page embeds the newest ~48 listings as escaped JSON.
async function fetchVinted(brandIds) {
  const ids = [brandIds].flat().map(id => `brand_ids[]=${id}`).join('&');
  const html = await (await get(`https://www.vinted.co.uk/catalog?${ids}&order=newest_first`)).text();
  const items = new Map();
  for (const chunk of html.replaceAll('\\"', '"').split('"productItem":{').slice(1)) {
    const m = chunk.match(/^"id":(\d+),"title":"(.*?)","url":"([^"]+)"/);
    if (!m) continue;
    let title = m[2];
    try { title = JSON.parse(`"${title}"`); } catch {}
    items.set(m[1], {
      id: m[1],
      title,
      url: `https://www.vinted.co.uk${m[3]}`,
      price: chunk.match(/"price":\{"amount":"([\d.]+)"/)?.[1],
      image: chunk.match(/"thumbnailUrl":"([^"]+)"/)?.[1],
      detail: chunk.match(/"secondLine":"(.*?)"/)?.[1],
    });
  }
  return [...items.values()];
}

const seen = fs.existsSync('seen.json') ? JSON.parse(fs.readFileSync('seen.json')) : {};
const feed = fs.existsSync('drops.json') ? JSON.parse(fs.readFileSync('drops.json')) : { drops: [] };
const now = new Date().toISOString();
const status = {};
const fresh = [];
const freshVinted = [];

// Returns items not seen before under `key`. First run for a key just seeds, otherwise everything would look "new".
function diff(key, items, brand, keep = Infinity) {
  const known = new Set(seen[key] || []);
  const out = known.size ? items.filter(it => !known.has(it.id)).map(it => ({ brand, found: now, ...it })) : [];
  seen[key] = [...new Set([...items.map(i => i.id), ...known])].slice(0, keep);
  return out;
}

for (const b of BRANDS) {
  try {
    if (!b.shopify && !b.sitemap && !b.next) status[b.name] = { ok: true, noShop: true };
    else {
      const items = b.shopify ? await fetchShopify(b.shopify) : b.next ? await fetchNext(b.next) : await fetchSitemap(b.sitemap);
      if (!items.length) throw new Error('no products found');
      if (b.cur) for (const it of items) it.cur = b.cur;
      fresh.push(...diff(b.name, items, b.name));
      status[b.name] = { ok: true, count: items.length };
    }
  } catch (e) {
    status[b.name] = { ok: false, error: e.message };
  }
  try {
    const items = await fetchVinted(b.vinted);
    if (!items.length) throw new Error('no listings found');
    // Vinted listings churn fast, so only remember recent ids.
    freshVinted.push(...diff(`vinted:${b.name}`, items, b.name, 3000));
    // Show current listings straight away, even on the seeding run.
    feed.vinted = [...items.map(it => ({ brand: b.name, found: now, ...it })), ...(feed.vinted || [])];
    status[b.name].vinted = true;
  } catch (e) {
    status[b.name].vinted = false;
  }
  console.log(b.name, status[b.name]);
}

feed.checked = now;
feed.status = status;
feed.drops = [...fresh, ...feed.drops].slice(0, 300);
// Newest first (Vinted ids increase over time), deduped, capped per brand so busy brands don't crowd out quiet ones.
const perBrand = {};
feed.vinted = [...new Map(feed.vinted.map(v => [v.id, v])).values()].sort((a, b) => b.id - a.id)
  .filter(v => (perBrand[v.brand] = (perBrand[v.brand] || 0) + 1) <= 60);
fs.writeFileSync('seen.json', JSON.stringify(seen));
fs.writeFileSync('drops.json', JSON.stringify(feed, null, 1));
console.log(`${fresh.length} new, ${freshVinted.length} new on Vinted`);

const { PUSH_SUBSCRIPTION, VAPID_PUBLIC, VAPID_PRIVATE } = process.env;
if ((fresh.length || freshVinted.length) && PUSH_SUBSCRIPTION && VAPID_PRIVATE) {
  const counts = {};
  for (const f of fresh) counts[f.brand] = (counts[f.brand] || 0) + 1;
  const lines = Object.entries(counts).map(([b, n]) => `${b}: ${n}`);
  if (freshVinted.length) lines.push(`Vinted: ${freshVinted.length} new listings`);
  // A bad secret shouldn't stop the day's data from being saved, so log and carry on.
  try {
    // Secrets pasted into GitHub often pick up stray spaces, newlines or quotes.
    webpush.setVapidDetails('mailto:drops@example.com', VAPID_PUBLIC, VAPID_PRIVATE.trim().replace(/^["']|["']$/g, ''));
    await webpush.sendNotification(JSON.parse(PUSH_SUBSCRIPTION.trim()), JSON.stringify({
      title: fresh.length ? `${fresh.length} new drop${fresh.length > 1 ? 's' : ''}` : 'New on Vinted',
      body: lines.join(' · '),
    }));
    console.log('Notification sent');
  } catch (e) {
    console.log(`::error::Notification not sent: ${e.message}`);
  }
}
