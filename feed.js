// ================== Google Merchant Center product feed ==================
// GET /google-feed.xml  →  RSS 2.0 з простором імен g: (специфікація Google Merchant)
//
// Звідки дані:
//   • Webflow RSS (/product/rss.xml) — назва, посилання, фото, а також ціна, SKU і опис,
//     якщо в Item Description налаштовано: {Price} | {SKU} | {Description}
//     (лише опубліковані на сайті товари);
//   • price-list.json — запасне джерело ціни/SKU для товарів, де рядок у RSS не розпізнано.
// Зіставлення — за файлом головного фото. Варіанти (аромадифузори 100/250/500 мл)
// мають спільне фото й одну сторінку, яка за замовчуванням показує найменший об'єм.
// Google звіряє ціну у фіді з ціною на сторінці, тому за замовчуванням у фід іде лише
// варіант, що відкривається на сторінці (найдешевший). FEED_ALL_VARIANTS=true — усі варіанти.

const SITE = "https://cocofloralcouturekyiv.ua";
const SOURCE_RSS = `${SITE}/product/rss.xml`;
const SHOP_NAME = "CoCo Floral Couture";
const CACHE_MS = 60 * 60 * 1000; // 1 година

let cache = { xml: null, at: 0 };

const imageKey = (url) => {
  try {
    const last = new URL(String(url)).pathname.split("/").pop() || "";
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return "";
  }
};

const xmlEscape = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const decodeEntities = (s) =>
  String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : "";
};

// Мінімальний парсер RSS Webflow (структура фіксована, тож бібліотека не потрібна)
function parseWebflowRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const img =
      block.match(/<media:content[^>]*url="([^"]+)"/)?.[1] ||
      block.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1] ||
      "";
    items.push({
      title: tag(block, "title").replace(/\s+/g, " ").trim(),
      link: tag(block, "link"),
      description: tag(block, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      image: decodeEntities(img),
    });
  }
  return items;
}

// Тип товару — для product_type (вільний текст, допомагає в кампаніях)
function productType(title) {
  const t = title.toLowerCase();
  if (t.includes("аромадифузор")) return "Аромадифузори";
  if (t.includes("свічка")) return "Ароматичні свічки";
  if (t.includes("коробка")) return "Квіти > Композиції в коробці";
  if (t.includes("корзина")) return "Квіти > Корзини з квітами";
  if (t.includes("монобукет")) return "Квіти > Монобукети";
  return "Квіти > Букети";
}

function brandFor(title) {
  if (/erbario toscano/i.test(title)) return "Erbario Toscano";
  if (/cote noire/i.test(title)) return "Cote Noire";
  return SHOP_NAME;
}

// PR-00001-250 → "250 мл" (у аромадифузорів число в кінці SKU — об'єм)
// Автоматичний опис, якщо в CMS поле Description порожнє.
// Лише факти, відомі з сайту: тип товару, назва (склад букета), бренд, об'єм, Київ, доставка/самовивіз.
const DELIVERY_NOTE = "Доставка по Києву або самовивіз з магазину.";

function autoDescription(title, sku) {
  const t = title.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  const lower = t.toLowerCase();
  const brand = brandFor(t);
  const volume = String(sku || "").match(/-(\d{2,4})$/)?.[1];

  if (lower.includes("аромадифузор")) {
    return `${t}. Аромадифузор ${brand} для дому${volume ? `, об'єм ${volume} мл` : ""}. ` +
      `Купуйте в ${SHOP_NAME} у Києві. ${DELIVERY_NOTE}`;
  }
  if (lower.includes("свічка")) {
    return `${t}. Ароматична свічка ${brand} для дому. Купуйте в ${SHOP_NAME} у Києві. ${DELIVERY_NOTE}`;
  }
  if (lower.includes("коробка")) {
    return `${t}. Квіткова композиція в коробці від флористів ${SHOP_NAME}, Київ. ${DELIVERY_NOTE}`;
  }
  if (lower.includes("корзина")) {
    return `${t}. Квіткова композиція в корзині від флористів ${SHOP_NAME}, Київ. ${DELIVERY_NOTE}`;
  }
  if (lower.includes("монобукет")) {
    return `${t}. Монобукет від флористів ${SHOP_NAME}, Київ. ${DELIVERY_NOTE}`;
  }
  return `${t}. Букет від флористів ${SHOP_NAME}, Київ. ${DELIVERY_NOTE}`;
}

function variantLabel(sku, title) {
  const m = String(sku).match(/-(\d{2,4})$/);
  if (m && /аромадифузор/i.test(title)) return `${m[1]} мл`;
  return "";
}

const formatPrice = (n) => `${Number(n).toFixed(2)} UAH`;

// Ціна, артикул і опис прямо з RSS Webflow.
// Рекомендований формат Item Description (Products Template → RSS feed settings):
//   {Description} | Ціна: {Price} ₴ | Стара ціна: {Compare-at price} ₴ | Артикул: {SKU}
// Частини розділяються "|", порядок довільний, "Стара ціна" необов'язкова.
// Також розбирається простий формат без підписів: "2 000 PR-00005-100 опис…".
// Webflow віддає ціну варіанта за замовчуванням ("2 000" / "1 999,50") — ту, що на сторінці.
const toNumber = (s) => {
  const n = Number(String(s).replace(/[\s\u00a0]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const NUM = "(\\d[\\d\\s\\u00a0]*(?:[.,]\\d{1,2})?)";

function parseRssMeta(desc) {
  const text = String(desc || "").replace(/\u00a0/g, " ").trim();
  if (!text) return null;

  // 1) формат з підписами
  const parts = text.split(/\s*[|\n]\s*/).map((x) => x.trim()).filter(Boolean);
  let price = null, compareAt = null, sku = null;
  const rest = [];
  for (const part of parts) {
    let m;
    if ((m = part.match(new RegExp(`^стара\\s+ціна\\s*:\\s*${NUM}?`, "i")))) {
      compareAt = m[1] ? toNumber(m[1]) : null; // порожнє поле — просто ігноруємо
    } else if ((m = part.match(new RegExp(`^ціна\\s*:\\s*${NUM}`, "i")))) {
      price = toNumber(m[1]);
    } else if ((m = part.match(/^артикул\s*:\s*(\S+)/i))) {
      sku = m[1];
    } else {
      rest.push(part);
    }
  }
  if (price && sku) {
    return { price, sku, compareAt, description: rest.join(" ").trim() };
  }

  // 2) простий формат: "2 000 PR-00005-100 опис…" або "2 000 | PR-00005-100 | опис"
  const m = text.match(
    new RegExp(`^${NUM}\\s*(?:₴|грн|uah)?\\s*\\|?\\s*([A-Za-zА-Яа-яІіЇїЄєҐґ][^\\s|]*)\\s*\\|?\\s*([\\s\\S]*)$`, "i")
  );
  if (!m) return null;
  const p = toNumber(m[1]);
  if (!p) return null;
  return { price: p, sku: m[2].trim(), compareAt: null, description: m[3].trim() };
}

// Спільний розбір: RSS-товари → записи фіду (використовують і фід, і /catalog.json)
function buildEntries(items, prices, { log = false } = {}) {
  // індекс прайсу за фото: одне фото → один або кілька SKU (варіанти)
  const byImage = new Map();
  for (const [sku, p] of Object.entries(prices || {})) {
    if (!p || typeof p !== "object") continue;
    const price = Number(p.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const key = imageKey(p.image);
    if (!key) continue;
    if (!byImage.has(key)) byImage.set(key, []);
    byImage.get(key).push({ sku, price });
  }

  const entries = [];
  const skipped = [];
  let fromRss = 0;
  let fromPriceList = 0;

  for (const it of items) {
    if (!it.link || !it.title) continue;
    const slug = it.link.split("/").filter(Boolean).pop();

    // 1) пріоритет — ціна й SKU з RSS Webflow (те саме, що бачить покупець на сторінці)
    // 2) запасний варіант — price-list.json (зіставлення за фото)
    const meta = parseRssMeta(it.description);
    let list;
    let itemDescription;
    if (meta) {
      list = [{ sku: meta.sku, price: meta.price, compareAt: meta.compareAt }];
      itemDescription = meta.description;
      fromRss++;
    } else {
      const variants = byImage.get(imageKey(it.image));
      if (!variants?.length) {
        skipped.push(it.title || it.link);
        continue;
      }
      variants.sort((a, b) => a.price - b.price);
      const allVariants = process.env.FEED_ALL_VARIANTS === "true";
      list = allVariants ? variants : variants.slice(0, 1);
      itemDescription = it.description;
      fromPriceList++;
    }

    list.forEach((v, idx) => {
      const label = variantLabel(v.sku, it.title);
      entries.push({
        id: v.sku,
        slug,
        isDefault: idx === 0,
        multi: list.length > 1,
        name: it.title,
        title: (label ? `${it.title} — ${label}` : it.title).slice(0, 150),
        description: (itemDescription || autoDescription(it.title, v.sku)).slice(0, 5000),
        link: it.link,
        image: it.image,
        price: v.price,
        compareAt: v.compareAt && v.compareAt > v.price ? v.compareAt : null,
        brand: brandFor(it.title),
        productType: productType(it.title),
      });
    });
  }

  if (log) {
    if (skipped.length) {
      console.warn(`[google-feed] немає ціни ні в RSS, ні в price-list.json, пропущено: ${skipped.join(" | ")}`);
    }
    console.log(`[google-feed] товарів: ${fromRss + fromPriceList} (ціна з RSS: ${fromRss}, з price-list: ${fromPriceList})`);
  }
  return entries;
}

function buildFeedXml(items, prices) {
  const entries = buildEntries(items, prices, { log: true });
  const out = entries.map((e) =>
    [
      "    <item>",
      `      <g:id>${xmlEscape(e.id)}</g:id>`,
      `      <g:title>${xmlEscape(e.title)}</g:title>`,
      `      <g:description>${xmlEscape(e.description)}</g:description>`,
      `      <g:link>${xmlEscape(e.link)}</g:link>`,
      `      <g:image_link>${xmlEscape(e.image)}</g:image_link>`,
      `      <g:availability>in_stock</g:availability>`,
      // якщо є стара (закреслена) ціна — це знижка: price = стара, sale_price = поточна
      ...(e.compareAt
        ? [`      <g:price>${formatPrice(e.compareAt)}</g:price>`, `      <g:sale_price>${formatPrice(e.price)}</g:sale_price>`]
        : [`      <g:price>${formatPrice(e.price)}</g:price>`]),
      `      <g:condition>new</g:condition>`,
      `      <g:brand>${xmlEscape(e.brand)}</g:brand>`,
      `      <g:identifier_exists>no</g:identifier_exists>`,
      `      <g:product_type>${xmlEscape(e.productType)}</g:product_type>`,
      e.multi ? `      <g:item_group_id>${xmlEscape(e.slug)}</g:item_group_id>` : "",
      "    </item>",
    ]
      .filter(Boolean)
      .join("\n")
  );

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">`,
    `  <channel>`,
    `    <title>${xmlEscape(SHOP_NAME)}</title>`,
    `    <link>${SITE}</link>`,
    `    <description>${xmlEscape(`${SHOP_NAME} — товари для Google Merchant Center`)}</description>`,
    ...out,
    `  </channel>`,
    `</rss>`,
    ``,
  ].join("\n");
}

// Легкий каталог для скрипта аналітики на сайті: slug → id (той самий, що у фіді), назва, ціна, бренд, категорія.
// id збігається з g:id у фіді — це потрібно для динамічного ремаркетингу Google Ads / Meta.
function buildCatalog(items, prices) {
  const out = {};
  for (const e of buildEntries(items, prices)) {
    if (!e.isDefault) continue;
    const [cat1, cat2] = e.productType.split(">").map((x) => x.trim());
    out[e.slug] = {
      id: e.id,
      name: e.name,
      price: e.price,
      brand: e.brand,
      category: cat1 || "",
      category2: cat2 || "",
    };
  }
  return out;
}

// ---------- джерело (RSS Webflow) з кешем, спільне для фіду й каталогу ----------
let source = { items: null, at: 0 };

async function loadSourceItems({ fresh = false } = {}) {
  if (!fresh && source.items && Date.now() - source.at < CACHE_MS) return source.items;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(SOURCE_RSS, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`Webflow RSS HTTP ${r.status}`);
    const items = parseWebflowRss(await r.text());
    source = { items, at: Date.now() };
    return items;
  } catch (err) {
    if (source.items) {
      console.error("[google-feed] RSS недоступний, використовую останню версію:", err?.message || err);
      return source.items; // віддаємо останню вдалу версію
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export function registerGoogleFeed(app, getPrices) {
  app.get("/google-feed.xml", async (req, res) => {
    try {
      const fresh = req.query.refresh === "1";
      if (!fresh && cache.xml && Date.now() - cache.at < CACHE_MS) {
        res.type("application/xml; charset=utf-8");
        return res.send(cache.xml);
      }
      const xml = buildFeedXml(await loadSourceItems({ fresh }), getPrices());
      cache = { xml, at: Date.now() };
      res.type("application/xml; charset=utf-8");
      return res.send(xml);
    } catch (err) {
      console.error("[google-feed]", err?.message || err);
      if (cache.xml) {
        res.type("application/xml; charset=utf-8");
        return res.send(cache.xml);
      }
      return res.status(502).type("text/plain").send("Feed temporarily unavailable");
    }
  });

  // Каталог для скрипта аналітики (GA4 / Google Ads / Meta) на сайті
  let catalogCache = { json: null, at: 0 };
  app.get("/catalog.json", async (req, res) => {
    try {
      if (!catalogCache.json || Date.now() - catalogCache.at >= CACHE_MS) {
        const catalog = buildCatalog(await loadSourceItems(), getPrices());
        catalogCache = { json: { ok: true, currency: "UAH", items: catalog }, at: Date.now() };
      }
      res.set("Cache-Control", "public, max-age=900");
      return res.json(catalogCache.json);
    } catch (err) {
      console.error("[catalog]", err?.message || err);
      if (catalogCache.json) return res.json(catalogCache.json);
      return res.status(502).json({ ok: false, error: "Catalog temporarily unavailable" });
    }
  });
}

// для тестів
export { parseWebflowRss, buildFeedXml, buildCatalog };
