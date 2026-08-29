// omarbuilds.com build script — zero dependencies.
// Reads content/, fetches the YouTube RSS feed, writes a static site to dist/.
import { readFile, writeFile, mkdir, rm, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import https from "node:https";

const ROOT = new URL(".", import.meta.url).pathname;
const DIST = path.join(ROOT, "dist");
const site = JSON.parse(await readFile(path.join(ROOT, "content/site.json"), "utf8"));
const css = await readFile(path.join(ROOT, "src/styles.css"), "utf8");
const BUILD_DATE = new Date().toISOString().slice(0, 10);

// ---------- helpers ----------
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const fmtViews = (n) => {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
};
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const thumb = (id, q = "hqdefault") => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
const isShort = (v) => /#\w/.test(v.title); // heuristic: Shorts titles carry hashtags

// ---------- YouTube feed (with cache fallback) ----------
const CACHE = path.join(ROOT, "content/videos-cache.json");
async function loadVideos() {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${site.youtubeChannelId}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
      const pick = (re) => (e.match(re) || [])[1] || "";
      const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return {
        id: pick(/<yt:videoId>([^<]+)/),
        title: unesc(pick(/<title>([^<]*)/)),
        published: pick(/<published>([^<]+)/),
        views: Number(pick(/<media:statistics views="(\d+)"/)),
        description: unesc(pick(/<media:description>([\s\S]*?)<\/media:description>/)).trim(),
      };
    });
    if (!entries.length) throw new Error("feed parsed to zero entries");
    await writeFile(CACHE, JSON.stringify({ fetched: new Date().toISOString(), entries }, null, 2));
    console.log(`feed: ${entries.length} videos fetched`);
    return entries;
  } catch (err) {
    console.warn(`feed: fetch failed (${err.message}) — using cache`);
    if (!existsSync(CACHE)) return [];
    return JSON.parse(await readFile(CACHE, "utf8")).entries;
  }
}

// ---------- follower counts (best-effort scrape, per-platform cache fallback) ----------
const STATS_CACHE = path.join(ROOT, "content/stats-cache.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Plain node:https rather than fetch — undici's default headers get a 400 from Instagram.
const get = (url, headers = {}, redirects = 3) => new Promise((resolve, reject) => {
  const req = https.get(url, { headers: { "user-agent": UA, "accept-language": "en-US", ...headers } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
      res.resume();
      return resolve(get(new URL(res.headers.location, url).href, headers, redirects - 1));
    }
    if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (d) => (body += d));
    res.on("end", () => resolve(body));
  });
  req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  req.on("error", reject);
});
const parseAbbrev = (s) => { // "1.96K" -> 1960
  const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KM])?/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6 }[(m[2] || "").toUpperCase()] || 1));
};
const STAT_SOURCES = {
  youtube: { noun: "subscribers", fetch: async () => {
    const html = await get(`https://www.youtube.com/channel/${site.youtubeChannelId}/about`, { cookie: "CONSENT=YES+1; SOCS=CAI" });
    const m = html.match(/"([\d.,]+[KM]?) subscribers"/);
    if (!m) throw new Error("no subscriber text");
    return parseAbbrev(m[1]);
  } },
  instagram: { noun: "followers", fetch: async () => {
    const json = await get("https://i.instagram.com/api/v1/users/web_profile_info/?username=omarbuilds", { "x-ig-app-id": "936619743392459" });
    const m = json.match(/"edge_followed_by":\{"count":(\d+)/);
    if (!m) throw new Error("no follower count");
    return Number(m[1]);
  } },
  tiktok: { noun: "followers", fetch: async () => {
    const html = await get("https://www.tiktok.com/@omarbuilds");
    const m = html.match(/"followerCount":(\d+)/);
    if (!m) throw new Error("no followerCount");
    return Number(m[1]);
  } },
  patreon: { noun: "members", fetch: async () => {
    const json = await get(`https://www.patreon.com/api/campaigns/${site.patreonCampaignId}?json-api-version=1.0`);
    const m = json.match(/"patron_count":(\d+)/);
    if (!m) throw new Error("no patron_count");
    return Number(m[1]);
  } },
};
async function loadStats() {
  const cached = existsSync(STATS_CACHE) ? JSON.parse(await readFile(STATS_CACHE, "utf8")) : {};
  const stats = { ...cached };
  await Promise.all(Object.entries(STAT_SOURCES).map(async ([id, src]) => {
    try {
      const count = await src.fetch();
      if (!Number.isFinite(count) || count <= 0) throw new Error(`bad value ${count}`);
      stats[id] = { count, noun: src.noun, updated: new Date().toISOString() };
      console.log(`stats: ${id} = ${count}`);
    } catch (err) {
      console.warn(`stats: ${id} failed (${err.message})${cached[id] ? ` — using cached ${cached[id].count}` : " — no cache, hidden"}`);
    }
  }));
  await writeFile(STATS_CACHE, JSON.stringify(stats, null, 2) + "\n");
  return stats;
}
const fmtCount = (n) => {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e5) return Math.round(n / 1e3) + "K";
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  if (n >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, "") + "K"; // 1.96K, like YouTube shows it
  return String(n);
};
const statFor = (stats, id) => stats[id] ? { short: fmtCount(stats[id].count), long: `${stats[id].count.toLocaleString("en-US")} ${stats[id].noun}` } : null;

// ---------- tiny markdown (enough for archived articles) ----------
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
}
function md(src) {
  const out = [];
  const lines = src.split("\n");
  let para = [], list = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
    if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`); list = []; }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { flush(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^[*-]\s+/.test(l)) { if (para.length) flush(); list.push(l.replace(/^[*-]\s+/, "")); continue; }
    if (l === "") { flush(); continue; }
    if (list.length) flush();
    para.push(l.trim());
  }
  flush();
  return out.join("\n");
}
function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  for (const line of (m ? m[1] : "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m ? m[2] : src };
}
async function loadPress() {
  const dir = path.join(ROOT, "content/press");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort().reverse();
  return Promise.all(files.map(async (f) => {
    const { meta, body } = frontmatter(await readFile(path.join(dir, f), "utf8"));
    return { ...meta, html: md(body) };
  }));
}

// ---------- layout ----------
function page({ title, description, canonical, body, image, noindex = false, cls = "" }) {
  const img = image || `${site.domain}/media/og-banner.jpg`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
${noindex ? '<meta name="robots" content="noindex, follow">' : ""}
<meta property="og:type" content="website">
<meta property="og:site_name" content="OmarBuilds">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@OmarBuilds">
<meta name="theme-color" content="#000000">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="OmarBuilds on YouTube" href="https://www.youtube.com/feeds/videos.xml?channel_id=${site.youtubeChannelId}">
<style>${css}</style>
</head>
<body class="${cls}">
<header class="top">
  <a class="logo" href="/" aria-label="OmarBuilds home"><img src="/media/logo.png" alt="OmarBuilds" width="1484" height="308"></a>
  <nav>
    <a href="/#videos">Videos</a>
    <a href="/#builds">Builds</a>
    <a href="/press/">Press</a>
    <a href="/links/">Links</a>
    <a class="btn btn-red small" href="/#files">Get the files</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <div class="foot-links">${site.links.map((l) => `<a href="${l.url}" rel="noopener">${esc(l.label)}</a>`).join("")}</div>
  <p>© ${new Date().getFullYear()} OmarBuilds · <a href="/press/">Press</a> · <a href="/links/">Links</a></p>
</footer>
</body>
</html>`;
}

const sectionHead = (label, title, extra = "") =>
  `<div class="sec-head"><h2 class="eyebrow"><span class="ck ck-l" aria-hidden="true"></span><span class="lbl">${esc(label)}</span><span class="ck ck-r" aria-hidden="true"></span></h2>${extra}</div>`;
const videoCard = (v, { big = false } = {}) => `
<a class="video ${big ? "video-big" : ""} ${isShort(v) ? "short" : ""}" href="${yt(v.id)}" rel="noopener">
  <span class="thumb"><img src="${thumb(v.id, big ? "maxresdefault" : "hqdefault")}" alt="" loading="lazy" width="480" height="360"><span class="play"></span>${isShort(v) ? '<span class="tag">Short</span>' : ""}</span>
  <span class="meta"><span class="vt">${esc(v.title)}</span><span class="vs">${fmtViews(v.views)} views · ${fmtDate(v.published)}</span></span>
</a>`;

// ---------- pages ----------
function homePage(videos, press, stats) {
  const byId = Object.fromEntries(videos.map((v) => [v.id, v]));
  const featured = byId[site.featuredVideoId] || videos.find((v) => !isShort(v)) || videos[0];
  const latest = videos.filter((v) => v.id !== featured?.id).slice(0, 6);
  const pressBySlug = Object.fromEntries(press.map((p) => [p.slug, p]));

  const builds = site.builds.map((b) => {
    const pr = b.press && pressBySlug[b.press];
    return `
<article class="build">
  <a class="build-img" href="${yt(b.videoId)}" rel="noopener"><img src="${thumb(b.videoId, "hqdefault")}" alt="" loading="lazy" width="480" height="360"></a>
  <div class="build-body">
    <span class="status ${/progress/i.test(b.status) ? "wip" : ""}">${esc(b.status)}</span>
    <h3>${esc(b.title)}</h3>
    <p>${esc(b.summary)}</p>
    <div class="row">
      <a class="btn small" href="${yt(b.videoId)}" rel="noopener">Watch</a>
      ${b.patreon ? `<a class="btn btn-red small" href="${site.patreon.url}" rel="noopener">Get files · ${esc(site.patreon.filesTier)} tier</a>` : ""}
      ${pr ? `<a class="btn ghost small" href="/press/${pr.slug}/">Featured on ${esc(pr.sourceName)}</a>` : ""}
    </div>
  </div>
</article>`;
  }).join("");

  const pressList = press.slice(0, 3).map(pressCard).join("");
// // <p class="eyebrow"><span class="br">[</span> Robotics · 3D printing · Arduino <span class="br">]</span></p>
  const body = `
<section class="hero">
  <div class="hero-text">
    
    <h1>I'm Omar <br> and I build <em>robots</em></h1>
    <p class="lead">Full builds on YouTube. Files, code and parts lists on Patreon.</p>
    <div class="row">
      <a class="btn btn-red" href="${site.links[0].url}" rel="noopener">▶ Watch on YouTube</a>
      <a class="btn btn-white" href="${site.patreon.url}" rel="noopener">Support on Patreon</a>
    </div>
  </div>
  ${featured ? `<a class="hero-video" href="${yt(featured.id)}" rel="noopener"><img src="${thumb(featured.id, "maxresdefault")}" alt="${esc(featured.title)}" width="1280" height="720"><span class="play"></span><span class="cap">Latest build · ${esc(featured.title)}</span></a>` : ""}
</section>

<section id="videos">
  ${sectionHead("Latest", "Fresh from the workshop", `<a class="more" href="${site.links[0].url}" rel="noopener">All videos →</a>`)}
  <div class="grid videos">${latest.map((v) => videoCard(v)).join("")}</div>
</section>

<section id="builds">
  ${sectionHead("Builds", "Things I've built (and you can too)")}
  <div class="builds">${builds}</div>
</section>

<section id="files">
  ${sectionHead("Patreon", "Get the files")}
  <p class="lead">${esc(site.patreon.blurb)}</p>
  <div class="tiers">${site.patreon.tiers.map((t) => `
    <div class="tier ${t.highlight ? "hi" : ""}">
      ${t.highlight ? '<span class="tier-flag">Files included</span>' : ""}
      <h3>${esc(t.name)}</h3>
      <p class="price">${esc(t.price)}<span>${esc(t.period)}</span></p>
      <p class="tier-tag">${esc(t.tagline)}</p>
      <ul class="checks">${t.perks.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
      <a class="btn ${t.highlight ? "btn-red" : ""}" href="${site.patreon.url}" rel="noopener">${t.price === "$0" ? "Join free" : `Join ${esc(t.name)}`}</a>
    </div>`).join("")}
  </div>
  <p class="fineprint">Prices in USD. Patreon may show your local currency at checkout.</p>
</section>

${press.length ? `<section id="press">
  ${sectionHead("Press", "In the news", `<a class="more" href="/press/">All coverage →</a>`)}
  <div class="grid press">${pressList}</div>
</section>` : ""}

<section id="about" class="about">
  <img src="/media/profile.jpg" alt="Omar" width="360" height="270" loading="lazy">
  <div>
    ${sectionHead("About", "Hey, I'm Omar")}
    <p class="lead">${esc(site.about)}</p>
    <div class="row">${site.links.map((l) => { const s = statFor(stats, l.id); return `<a class="btn small social s-${l.id}" href="${l.url}" rel="noopener"${s ? ` title="${esc(s.long)}"` : ""}>${esc(l.label)}${s ? `<span class="cnt">${s.short}</span>` : ""}</a>`; }).join("")}</div>
  </div>
</section>`;

  return page({ title: "OmarBuilds: I build robots", description: site.description, canonical: `${site.domain}/`, body });
}

const pressCard = (p) => `
<a class="press-card" href="/press/${p.slug}/">
  ${p.image ? `<img src="/press/images/${p.image}" alt="" loading="lazy" width="600" height="400">` : ""}
  <span class="meta"><span class="src">${esc(p.sourceName)} · ${fmtDate(p.date)}</span><span class="vt">${esc(p.title)}</span></span>
</a>`;

function pressIndexPage(press) {
  const body = `
<section class="page-head">
  ${sectionHead("Press", "Coverage of my builds")}
  <p class="lead">Articles written about OmarBuilds projects. Each one is archived here with a link to the original, so it stays readable even if the source ever goes offline.</p>
</section>
<section><div class="grid press">${press.map(pressCard).join("")}</div></section>`;
  return page({ title: "Press — OmarBuilds", description: "Articles and coverage about OmarBuilds robotics projects.", canonical: `${site.domain}/press/`, body });
}

function pressArticlePage(p) {
  const wayback = `https://web.archive.org/web/*/${p.sourceUrl}`;
  const body = `
<article class="article">
  <p class="eyebrow ck-wrap"><span class="ck ck-l" aria-hidden="true"></span><span class="lbl">Archived copy</span><span class="ck ck-r" aria-hidden="true"></span></p>
  <h1>${esc(p.title)}</h1>
  <p class="byline">By ${esc(p.author)} · <a href="${p.sourceUrl}" rel="noopener">${esc(p.sourceName)}</a> · ${fmtDate(p.date)}</p>
  <div class="notice">
    <strong>This is a courtesy archive.</strong> The original article was published by ${esc(p.sourceName)} and all rights remain with them.
    <a href="${p.sourceUrl}" rel="noopener">Read the original →</a> · <a href="${wayback}" rel="noopener">Wayback Machine</a> · Archived ${fmtDate(p.retrieved)}
  </div>
  ${p.image ? `<img class="hero-img" src="/press/images/${p.image}" alt="" width="1200" height="800">` : ""}
  ${p.excerpt ? `<p class="lead">${esc(p.excerpt)}</p>` : ""}
  <div class="prose">${p.html}</div>
  <div class="notice end">Originally published at <a href="${p.sourceUrl}" rel="noopener">${esc(p.sourceUrl)}</a></div>
  ${p.build ? `<p class="row"><a class="btn btn-red" href="/#files">Build the ${esc(p.build)} yourself →</a><a class="btn ghost" href="/press/">← All press</a></p>` : ""}
</article>`;
  return page({
    title: `${p.title} — ${p.sourceName} (archived)`,
    description: p.excerpt || `${p.sourceName} coverage of OmarBuilds.`,
    canonical: `${site.domain}/press/${p.slug}/`,
    image: p.image ? `${site.domain}/press/images/${p.image}` : undefined,
    noindex: true, // archived third-party text — don't compete with the original in search
    body,
  });
}

function linksPage(stats) {
  const body = `
<section class="linktree">
  <img class="avatar" src="/media/profile.jpg" alt="Omar" width="120" height="90">
  <h1>OmarBuilds</h1>
  <p class="lead">${esc(site.tagline)}</p>
  <div class="stack">
    ${site.links.map((l) => { const s = statFor(stats, l.id); return `<a class="btn wide social s-${l.id}" href="${l.url}" rel="noopener"><span>${esc(l.label)}${s ? `<span class="cnt">${s.short}</span>` : ""}</span><span class="handle">${esc(l.handle)}</span></a>`; }).join("")}
    <a class="btn ghost wide" href="/"><span>omarbuilds.com</span><span class="handle">the full site</span></a>
  </div>
</section>`;
  return page({ title: "Links — OmarBuilds", description: "All OmarBuilds social links in one place.", canonical: `${site.domain}/links/`, body, cls: "minimal" });
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#000"/><path d="M14 16h8v4h-4v24h4v4h-8zM50 16h-8v4h4v24h-4v4h8z" fill="#8a8a8a"/><text x="32" y="43" font-family="Helvetica,Arial,sans-serif" font-weight="900" font-size="30" text-anchor="middle" fill="#e10600">O</text></svg>`;

// ---------- write ----------
const [videos, press, stats] = await Promise.all([loadVideos(), loadPress(), loadStats()]);
await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, "press/images"), { recursive: true });
await mkdir(path.join(DIST, "links"), { recursive: true });
await mkdir(path.join(DIST, "media"), { recursive: true });

const out = (rel, s) => writeFile(path.join(DIST, rel), s);
await out("index.html", homePage(videos, press, stats));
await out("press/index.html", pressIndexPage(press));
for (const p of press) {
  await mkdir(path.join(DIST, "press", p.slug), { recursive: true });
  await out(`press/${p.slug}/index.html`, pressArticlePage(p));
}
await out("links/index.html", linksPage(stats));
await out("favicon.svg", favicon);
await out("CNAME", new URL(site.domain).host);
await out("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${site.domain}/sitemap.xml\n`);
await out("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", "/press/", "/links/"].map((u) => `  <url><loc>${site.domain}${u}</loc><lastmod>${BUILD_DATE}</lastmod></url>`).join("\n")}\n</urlset>\n`);
for (const f of ["profile.jpg", "og-banner.jpg", "Omarbuilds_Banner.png", "logo.png"]) await cp(path.join(ROOT, "media", f), path.join(DIST, "media", f));
if (existsSync(path.join(ROOT, "content/press/images"))) await cp(path.join(ROOT, "content/press/images"), path.join(DIST, "press/images"), { recursive: true });
console.log(`built dist/ — ${videos.length} videos, ${press.length} press articles`);
