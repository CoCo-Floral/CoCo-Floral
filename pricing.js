// ================== Ціни букетів з інгредієнтів ==================
// Ціна букета = Σ (к-сть × ціна інгредієнта) + послуга упаковки 10%, вгору до кратного 50 грн.
// Дані (інгредієнти і склад) надсилає Google Таблиця; бекенд рахує, оновлює SKU у Webflow,
// публікує сайт і тримає знімок цін усіх товарів у Postgres (замість ручного price-list.json).
//
// Ендпоінти (заголовок x-pricing-key = PRICING_KEY):
//   GET  /admin/pricing/products   → { ok, items: [{ sku, title, price }] }
//   POST /admin/pricing/recalc     { ingredients:[{name,price}], bouquets:[{sku,items:[{ingredient,qty}]}] }
//                                  → { ok, jobId }   (409, якщо оновлення вже йде)
//   GET  /admin/pricing/jobs/:id   → { ok, state, done, total, results, published, publishError, error }
//   POST /admin/pricing/sync       → { ok, total, changed: [sku] }   (ручна синхронізація цін з Webflow)
//   POST /webhooks/webflow/site-publish — вебхук Webflow «Site publish» (без ключа: він лише
//        запускає синхронізацію, ціни бекенд сам читає з Webflow; не частіше разу на хвилину)
//
// Склад букета: під час перерахунку в поле товару «Склад букету» (Rich Text) пишеться список
// «назва — N шт.»; якщо в товару кілька розмірів зі складом — розділи «Розмір S», «Розмір M»…
//
// Секрети: WEBFLOW_TOKEN (ecommerce + sites, read/write; для складу ще CMS read), PRICING_KEY.
// Необов'язково: PRICING_COMPOSITION_FIELD — slug поля складу (тоді CMS read не потрібен),
//                PRICING_COMPOSITION_FIELD_NAME — назва поля (за замовчуванням «Склад букету»).
// Необов'язково: WEBFLOW_SITE_ID (інакше береться єдиний сайт токена),
//                PRICING_PUBLISH = subdomain (за замовчуванням) | all | none.

import crypto from "crypto";

export const PACKAGING_PERCENT = 10;
export const ROUND_TO = 50;

const WF_API = "https://api.webflow.com/v2";
const WF_MIN_INTERVAL_MS = 550; // ~110 запитів/хв при ліміті 120
const STALE_JOB_MINUTES = 15;   // завдання «running» старше за це вважається перерваним

// ---------- розрахунок ----------
const toKop = (uah) => Math.round(Number(uah) * 100);

// items: [{ ingredient, qty }], prices: Map(name → ціна в грн)
export function calcBouquetPrice(items, prices) {
  let sumKop = 0;
  for (const it of items) {
    const p = prices.get(it.ingredient);
    if (p === undefined) throw new Error(`Інгредієнта «${it.ingredient}» немає в довіднику`);
    sumKop += toKop(p) * it.qty;
  }
  // ціле число копійок × (100 + %) / 100 → вгору до ROUND_TO грн; лише цілочисельна арифметика
  const denom = 100 * 100 * ROUND_TO;
  const price = Math.ceil((sumKop * (100 + PACKAGING_PERCENT)) / denom) * ROUND_TO;
  return { sum: sumKop / 100, price };
}

// ---------- перевірка даних з таблиці ----------
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._*-]{0,63}$/;

export function validatePayload(body) {
  const errors = [];
  const ingredients = Array.isArray(body?.ingredients) ? body.ingredients : null;
  const bouquets = Array.isArray(body?.bouquets) ? body.bouquets : null;
  if (!ingredients) errors.push("ingredients: очікується масив");
  if (!bouquets) errors.push("bouquets: очікується масив");
  if (errors.length) return { errors };
  if (ingredients.length > 2000) errors.push("забагато інгредієнтів");
  if (bouquets.length > 5000) errors.push("забагато букетів");

  const prices = new Map();
  const siteNames = new Map();
  for (const ing of ingredients) {
    const name = String(ing?.name ?? "").trim();
    const price = Number(ing?.price);
    if (!name) { errors.push("інгредієнт без назви"); continue; }
    if (prices.has(name)) errors.push(`інгредієнт «${name}» повторюється`);
    if (!Number.isFinite(price) || price <= 0 || price > 1e6) errors.push(`«${name}»: некоректна ціна`);
    prices.set(name, price);
    const siteName = String(ing?.siteName ?? "").trim().slice(0, 200);
    if (siteName) siteNames.set(name, siteName);
  }

  const seen = new Set();
  const list = [];
  for (const b of bouquets) {
    const sku = String(b?.sku ?? "").trim();
    if (!SKU_RE.test(sku)) { errors.push(`некоректний SKU «${sku}»`); continue; }
    if (seen.has(sku)) errors.push(`SKU ${sku} повторюється`);
    seen.add(sku);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) { errors.push(`${sku}: порожній склад`); continue; }
    const clean = [];
    for (const it of items) {
      const ingredient = String(it?.ingredient ?? "").trim();
      const qty = Number(it?.qty);
      if (!prices.has(ingredient)) errors.push(`${sku}: «${ingredient}» немає в довіднику`);
      if (!Number.isInteger(qty) || qty < 1 || qty > 10000) errors.push(`${sku}: «${ingredient}» — некоректна кількість`);
      clean.push({ ingredient, qty });
    }
    list.push({ sku, items: clean });
  }
  return { errors, prices, siteNames, bouquets: list };
}

// ---------- Webflow ----------
export function createWebflowClient({ token = process.env.WEBFLOW_TOKEN, siteId = process.env.WEBFLOW_SITE_ID, fetchImpl = fetch, minIntervalMs = WF_MIN_INTERVAL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = 0;
  let cachedSiteId = siteId || null;

  async function call(path, { method = "GET", body } = {}, attempt = 0) {
    if (!token) throw new Error("WEBFLOW_TOKEN не задано");
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    let r, json;
    try {
      r = await fetchImpl(WF_API + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      json = await r.json().catch(() => ({}));
    } finally {
      clearTimeout(t);
    }

    if (r.status === 429 && attempt < 3) {
      const retry = Number(r.headers?.get?.("retry-after")) || 60;
      await sleep(retry * 1000);
      return call(path, { method, body }, attempt + 1);
    }
    if (!r.ok) {
      const msg = json?.message || json?.msg || JSON.stringify(json).slice(0, 300);
      const err = new Error(`Webflow ${method} ${path.split("?")[0]}: HTTP ${r.status} ${msg}`);
      err.status = r.status;
      throw err;
    }
    return json;
  }

  async function getSiteId() {
    if (cachedSiteId) return cachedSiteId;
    const { sites = [] } = await call("/sites");
    if (sites.length !== 1) {
      throw new Error(`Токен бачить ${sites.length} сайт(ів) — задай WEBFLOW_SITE_ID`);
    }
    cachedSiteId = sites[0].id;
    return cachedSiteId;
  }

  // усі SKU сайту, плоским списком
  async function listSkus() {
    const site = await getSiteId();
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const { items = [], pagination = {} } = await call(`/sites/${site}/products?limit=100&offset=${offset}`);
      for (const { product, skus = [] } of items) {
        if (product?.isArchived) continue;
        for (const s of skus) {
          const f = s.fieldData || {};
          const img = f["main-image"];
          out.push({
            productId: product.id,
            skuId: s.id,
            sku: String(f.sku || "").trim(),
            title: String(product.fieldData?.name || f.name || "").trim(),
            skuName: f.name,
            skuSlug: f.slug,
            skuValues: f["sku-values"],
            priceRaw: f.price || null,
            image: typeof img === "string" ? img : img?.url || "",
            isDraft: !!product.isDraft,
            product: { id: product.id, fieldData: product.fieldData || {} },
          });
        }
      }
      if (!items.length || offset + 100 >= (pagination.total ?? 0)) break;
    }
    return out;
  }

  // Webflow вимагає в PATCH значення опцій варіанта (sku-values), інакше 409 «Duplicate SKU».
  // Фото не передаємо: URL у main-image Webflow сприймає як нове завантаження.
  async function updateSkuPrice(s, newRawValue) {
    const site = await getSiteId();
    const fieldData = {
      name: s.skuName,
      slug: s.skuSlug,
      price: { ...(s.priceRaw || {}), value: newRawValue },
    };
    if (s.skuValues && typeof s.skuValues === "object") fieldData["sku-values"] = s.skuValues;
    if (s.sku) fieldData.sku = s.sku;
    return call(`/sites/${site}/products/${s.productId}/skus/${s.skuId}`, {
      method: "PATCH",
      body: { sku: { fieldData } },
    });
  }

  // slug поля «Склад букету» у колекції Products (потрібен CMS read або PRICING_COMPOSITION_FIELD)
  let compositionField = process.env.PRICING_COMPOSITION_FIELD || null;
  async function getCompositionFieldSlug() {
    if (compositionField) return compositionField;
    const wanted = (process.env.PRICING_COMPOSITION_FIELD_NAME || "Склад букету").trim().toLowerCase();
    const site = await getSiteId();
    let collections;
    try {
      ({ collections = [] } = await call(`/sites/${site}/collections`));
    } catch (err) {
      if (err.status === 403 || err.status === 401) {
        throw new Error("Токен Webflow без доступу до CMS: потрібне право CMS → Read (або секрет PRICING_COMPOSITION_FIELD)");
      }
      throw err;
    }
    const products = collections.find((c) => c.slug === "product") ||
      collections.find((c) => /^(products|продукти|товари)$/i.test(String(c.displayName || "").trim()));
    if (!products) throw new Error("Не знайдено колекцію Products");
    const { fields = [] } = await call(`/collections/${products.id}`);
    const f = fields.find((x) => String(x.displayName || "").trim().toLowerCase() === wanted);
    if (!f) throw new Error(`У Products немає поля «${process.env.PRICING_COMPOSITION_FIELD_NAME || "Склад букету"}»`);
    if (f.type !== "RichText") throw new Error(`Поле «${f.displayName}» має тип ${f.type}, очікується Rich Text`);
    compositionField = f.slug;
    return compositionField;
  }

  // Як і для SKU, передаємо ідентифікуючі поля товару (name, slug, sku-properties) як є
  async function updateProductField(product, fieldSlug, value) {
    const site = await getSiteId();
    const f = product.fieldData || {};
    const fieldData = { name: f.name, slug: f.slug, [fieldSlug]: value };
    if (f["sku-properties"]) fieldData["sku-properties"] = f["sku-properties"];
    await call(`/sites/${site}/products/${product.id}`, {
      method: "PATCH",
      body: { product: { fieldData } },
    });
    product.fieldData = { ...f, [fieldSlug]: value };
  }

  async function publish(mode) {
    if (mode === "none") return { published: false, skipped: true };
    const site = await getSiteId();
    const body = { publishToWebflowSubdomain: true };
    if (mode === "all") {
      const { customDomains = [] } = await call(`/sites/${site}/custom_domains`);
      body.customDomains = customDomains.map((d) => d.id);
    }
    // публікація — не частіше разу на хвилину; на 429 call() сам чекає Retry-After
    await call(`/sites/${site}/publish`, { method: "POST", body });
    return { published: true };
  }

  return { call, getSiteId, listSkus, updateSkuPrice, publish, getCompositionFieldSlug, updateProductField };
}

// Webflow зберігає ціну в мінімальних одиницях (копійках), але перевіряємо на реальних даних:
// порівнюємо з поточним знімком цін. Без надійного збігу нічого не оновлюємо.
export function detectPriceScale(skus, knownPrices) {
  let x100 = 0, x1 = 0;
  for (const s of skus) {
    const known = Number(knownPrices?.[s.sku]?.price);
    const v = Number(s.priceRaw?.value);
    if (!s.sku || !Number.isFinite(known) || known <= 0 || !Number.isFinite(v)) continue;
    if (v === known * 100) x100++;
    else if (v === known) x1++;
  }
  if (x100 >= 3 && x100 > x1 * 4) return 100;
  if (x1 >= 3 && x1 > x100 * 4) return 1;
  throw new Error(`Не вдалося визначити одиниці ціни у Webflow (збігів ×100: ${x100}, ×1: ${x1}). Оновлення скасовано.`);
}

// ---------- склад букета для сайту ----------
const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lowerFirst = (t) => (t ? t.charAt(0).toLocaleLowerCase("uk") + t.slice(1) : t);

export function sizeLabel(sku) {
  const last = String(sku).split("-").pop().toUpperCase();
  return SIZE_ORDER.includes(last) ? last : null;
}

// entries: [{ sku, items:[{ingredient, qty}] }] одного товару → HTML для Rich Text
export function buildCompositionHtml(entries, siteNames) {
  const list = (items) =>
    "<ul>" + items.map((it) => {
      const name = siteNames.get(it.ingredient) || lowerFirst(it.ingredient);
      return `<li>${escapeHtml(name)} — ${it.qty} шт.</li>`;
    }).join("") + "</ul>";
  if (entries.length === 1) return list(entries[0].items);
  const rank = (e) => { const l = sizeLabel(e.sku); return l ? SIZE_ORDER.indexOf(l) : 100; };
  return [...entries]
    .sort((a, b) => rank(a) - rank(b) || a.sku.localeCompare(b.sku))
    .map((e) => `<p><strong>${escapeHtml(sizeLabel(e.sku) ? `Розмір ${sizeLabel(e.sku)}` : e.sku)}</strong></p>${list(e.items)}`)
    .join("");
}

// порівнюємо як текст: Webflow може по-своєму переформатувати HTML
export function sameRichText(a, b) {
  const norm = (h) => String(h || "")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

// ---------- сховище (Postgres) ----------
export async function initPricingStore(pool, seedPrices) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_prices (
      sku        TEXT PRIMARY KEY,
      title      TEXT,
      image      TEXT,
      price      NUMERIC(12,2) NOT NULL,
      source     TEXT NOT NULL DEFAULT 'webflow',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pricing_jobs (
      id            TEXT PRIMARY KEY,
      state         TEXT NOT NULL,
      total         INT NOT NULL DEFAULT 0,
      done          INT NOT NULL DEFAULT 0,
      results       JSONB NOT NULL DEFAULT '[]'::jsonb,
      published     BOOLEAN,
      publish_error TEXT,
      error         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at   TIMESTAMPTZ
    );
    -- одне оновлення одночасно на всі машини; працює і через PgBouncer (на відміну від advisory lock)
    CREATE UNIQUE INDEX IF NOT EXISTS pricing_jobs_one_running ON pricing_jobs ((true)) WHERE state = 'running';
  `);
  // перший запуск: переносимо price-list.json, щоб оплата працювала ще до першого оновлення
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM product_prices`);
  if (rows[0].n === 0) {
    const entries = Object.entries(seedPrices || {}).filter(([, p]) => Number.isFinite(Number(p?.price)));
    for (const [sku, p] of entries) {
      await pool.query(
        `INSERT INTO product_prices (sku, title, image, price, source) VALUES ($1,$2,$3,$4,'seed')
         ON CONFLICT (sku) DO NOTHING`,
        [sku, p.title || null, p.image || null, Number(p.price)]
      );
    }
    console.log(`[pricing] знімок цін створено з price-list.json: ${entries.length} SKU`);
  }
}

export async function loadPricesFromDb(pool) {
  const { rows } = await pool.query(`SELECT sku, title, image, price FROM product_prices`);
  const out = {};
  for (const r of rows) {
    out[r.sku] = {
      price: Number(r.price),
      ...(r.title ? { title: r.title } : {}),
      ...(r.image ? { image: r.image } : {}),
    };
  }
  return out;
}

// sourceFor(sku) → 'formula' | 'webflow' | null (null — лишити попереднє джерело)
async function saveSnapshot(pool, skus, scale, sourceFor) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const s of skus) {
      const v = Number(s.priceRaw?.value);
      if (!s.sku || !Number.isFinite(v) || v <= 0) continue;
      await client.query(
        `INSERT INTO product_prices (sku, title, image, price, source, updated_at)
         VALUES ($1,$2,$3,$4, COALESCE($5, 'webflow'), now())
         ON CONFLICT (sku) DO UPDATE SET
           title = EXCLUDED.title, image = EXCLUDED.image, price = EXCLUDED.price,
           source = COALESCE($5, product_prices.source), updated_at = now()`,
        [s.sku, s.title || null, s.image || null, v / scale, sourceFor(s.sku)]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function saveJob(pool, job) {
  await pool.query(
    `INSERT INTO pricing_jobs (id, state, total, done, results, published, publish_error, error, finished_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       state = EXCLUDED.state, total = EXCLUDED.total, done = EXCLUDED.done, results = EXCLUDED.results,
       published = EXCLUDED.published, publish_error = EXCLUDED.publish_error, error = EXCLUDED.error,
       finished_at = EXCLUDED.finished_at`,
    [job.id, job.state, job.total, job.done, JSON.stringify(job.results), job.published ?? null,
     job.publishError ?? null, job.error ?? null, job.state === "running" ? null : new Date()]
  );
}

// ---------- запис складу у Webflow ----------
// Повертає кількість оновлених товарів; статус пише в results[].composition
async function updateCompositions({ wf, payload, bySku, results, log }) {
  const resultBySku = new Map(results.map((r) => [r.sku, r]));
  const byProduct = new Map();
  for (const b of payload.bouquets) {
    const s = bySku.get(b.sku);
    if (!s) continue;
    if (!byProduct.has(s.productId)) byProduct.set(s.productId, { product: s.product, entries: [] });
    byProduct.get(s.productId).entries.push(b);
  }
  if (!byProduct.size) return 0;

  let fieldSlug;
  try {
    fieldSlug = await wf.getCompositionFieldSlug();
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 200);
    log.error("[pricing] склад:", msg);
    for (const { entries } of byProduct.values()) {
      for (const e of entries) { const r = resultBySku.get(e.sku); if (r) r.composition = `error: ${msg}`; }
    }
    return 0;
  }

  let updated = 0;
  for (const { product, entries } of byProduct.values()) {
    let status;
    try {
      const html = buildCompositionHtml(entries, payload.siteNames || new Map());
      if (sameRichText(product.fieldData?.[fieldSlug], html)) {
        status = "unchanged";
      } else {
        await wf.updateProductField(product, fieldSlug, html);
        updated++;
        status = "updated";
      }
    } catch (err) {
      status = `error: ${String(err?.message || err).slice(0, 200)}`;
    }
    for (const e of entries) { const r = resultBySku.get(e.sku); if (r) r.composition = status; }
  }
  return updated;
}

// ---------- сам перерахунок ----------
// Чиста логіка без HTTP-сервера: легко тестувати з підробленими wf/pool.
export async function runRecalc({ wf, pool, payload, getPrices, onPricesChanged, publishMode, job, log = console }) {
  const save = () => saveJob(pool, job).catch((e) => log.error("[pricing] saveJob:", e?.message || e));
  try {
    const skus = await wf.listSkus();
    const scale = detectPriceScale(skus, getPrices());
    const bySku = new Map();
    for (const s of skus) if (s.sku && !bySku.has(s.sku)) bySku.set(s.sku, s);

    job.total = payload.bouquets.length;
    await save();

    let changed = 0;
    for (const b of payload.bouquets) {
      const s = bySku.get(b.sku);
      let result;
      try {
        const { price } = calcBouquetPrice(b.items, payload.prices);
        if (!s) {
          result = { sku: b.sku, price, status: "error", message: "SKU не знайдено у Webflow" };
        } else {
          const oldRaw = Number(s.priceRaw?.value);
          const newRaw = price * scale;
          if (oldRaw === newRaw) {
            result = { sku: b.sku, price, status: "unchanged" };
          } else {
            await wf.updateSkuPrice(s, newRaw);
            s.priceRaw = { ...(s.priceRaw || {}), value: newRaw };
            changed++;
            result = { sku: b.sku, price, oldPrice: oldRaw / scale, status: "updated" };
          }
        }
      } catch (err) {
        result = { sku: b.sku, status: "error", message: String(err?.message || err).slice(0, 300) };
      }
      job.results.push(result);
      job.done++;
      if (job.done % 5 === 0) await save();
    }

    // склад букета → поле товару «Склад букету»
    changed += await updateCompositions({ wf, payload, bySku, results: job.results, log });

    // знімок усіх товарів (і букетів, і ваз тощо) — саме з нього беруться ціни для оплати
    const formula = new Set(payload.bouquets.map((b) => b.sku));
    await saveSnapshot(pool, skus, scale, (sku) => (formula.has(sku) ? "formula" : "webflow"));
    await onPricesChanged();

    if (changed > 0) {
      try {
        const r = await wf.publish(publishMode);
        job.published = !!r.published;
        if (r.skipped) job.publishError = "публікацію вимкнено (PRICING_PUBLISH=none)";
      } catch (err) {
        job.published = false;
        job.publishError = String(err?.message || err).slice(0, 300);
      }
    } else {
      job.published = false;
      job.publishError = "цін не змінено — публікація не потрібна";
    }
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = String(err?.message || err).slice(0, 500);
    log.error("[pricing] job failed:", job.error);
  }
  await save();
  return job;
}

// ---------- синхронізація з Webflow (вази, дифузори, ручні зміни цін) ----------
// Пише в базу лише те, що змінилось. Повертає список змінених SKU.
export async function syncFromWebflow({ wf, pool, getPrices, onPricesChanged }) {
  const skus = await wf.listSkus();
  const known = getPrices();
  const scale = detectPriceScale(skus, known);
  const changed = skus.filter((s) => {
    const v = Number(s.priceRaw?.value);
    if (!s.sku || !Number.isFinite(v) || v <= 0) return false;
    const k = known[s.sku];
    return !k || Number(k.price) !== v / scale || (k.title || "") !== (s.title || "") || (k.image || "") !== (s.image || "");
  });
  if (changed.length) {
    await saveSnapshot(pool, changed, scale, () => null);
    await onPricesChanged();
  }
  return { total: skus.length, changed: changed.map((s) => s.sku) };
}

// Не частіше разу на cooldownMs; запити, що прийшли під час/після синхронізації, зливаються в один.
export function createSyncScheduler(run, { cooldownMs = 60 * 1000, log = console } = {}) {
  let running = false, pending = false, timer = null, last = -Infinity;
  async function exec() {
    timer = null;
    running = true;
    last = Date.now();
    try {
      const r = await run();
      if (r?.changed?.length) log.log(`[pricing] синхронізація з Webflow: змінено ${r.changed.length} SKU: ${r.changed.slice(0, 20).join(", ")}`);
    } catch (err) {
      log.error("[pricing] синхронізація з Webflow не вдалася:", err?.message || err);
    }
    running = false;
    if (pending) { pending = false; schedule(); }
  }
  function schedule() {
    if (running) { pending = true; return "queued"; }
    if (timer) return "scheduled";
    const wait = Math.max(0, last + cooldownMs - Date.now());
    timer = setTimeout(exec, wait);
    return wait ? "scheduled" : "started";
  }
  return { schedule };
}

// Публікація лише на *.webflow.io не змінює ціни на основному сайті — тоді синхронізація не потрібна
export function isStagingOnlyPublish(body) {
  const domains = body?.payload?.domains;
  return Array.isArray(domains) && domains.length > 0 &&
    domains.every((d) => /(^|\.)webflow\.io$/i.test(String(d?.url ?? d).replace(/^https?:\/\//, "").replace(/\/.*$/, "")));
}

// ---------- HTTP ----------
function requirePricingKey(req, res, next) {
  const expected = process.env.PRICING_KEY || "";
  const got = String(req.headers["x-pricing-key"] || "");
  if (expected.length < 20) return res.status(500).json({ ok: false, error: "PRICING_KEY не задано або закороткий" });
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

export function registerPricing(app, { pool, getPrices, onPricesChanged, wf = createWebflowClient() }) {
  const publishMode = ["subdomain", "all", "none"].includes(process.env.PRICING_PUBLISH)
    ? process.env.PRICING_PUBLISH
    : "subdomain";

  const deps = { wf, pool, getPrices, onPricesChanged };
  const scheduler = createSyncScheduler(() => syncFromWebflow(deps));

  // Вебхук Webflow «Site publish»: Site settings → Apps & Integrations → Webhooks
  app.post("/webhooks/webflow/site-publish", (req, res) => {
    if (isStagingOnlyPublish(req.body)) return res.json({ ok: true, skipped: "staging-only publish" });
    res.json({ ok: true, sync: scheduler.schedule() });
  });

  app.post("/admin/pricing/sync", requirePricingKey, async (req, res) => {
    try {
      const r = await syncFromWebflow(deps);
      res.json({ ok: true, ...r });
    } catch (err) {
      console.error("[pricing] sync:", err?.message || err);
      res.status(502).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.get("/admin/pricing/products", requirePricingKey, async (req, res) => {
    try {
      const skus = await wf.listSkus();
      const scale = detectPriceScale(skus, getPrices());
      res.json({
        ok: true,
        items: skus
          .filter((s) => s.sku)
          .map((s) => ({ sku: s.sku, title: s.title, price: Number(s.priceRaw?.value) / scale, draft: s.isDraft })),
      });
    } catch (err) {
      console.error("[pricing] products:", err?.message || err);
      res.status(502).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post("/admin/pricing/recalc", requirePricingKey, async (req, res) => {
    const v = validatePayload(req.body);
    if (v.errors.length) return res.status(400).json({ ok: false, error: v.errors.slice(0, 20).join("; ") });

    const job = {
      id: "pj_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"),
      state: "running", total: v.bouquets.length, done: 0, results: [],
    };
    try {
      // завдання, що «зависло» (машину зупинили посеред роботи), не повинно блокувати назавжди
      await pool.query(
        `UPDATE pricing_jobs SET state = 'failed', error = 'Перервано: сервер перезапустився', finished_at = now()
         WHERE state = 'running' AND created_at < now() - ($1 || ' minutes')::interval`,
        [String(STALE_JOB_MINUTES)]
      );
      // унікальний індекс pricing_jobs_one_running не дасть створити друге активне завдання
      await saveJob(pool, job);
    } catch (err) {
      if (err?.code === "23505") {
        return res.status(409).json({ ok: false, error: "Оновлення цін уже виконується. Спробуй за хвилину." });
      }
      console.error("[pricing] create job:", err?.message || err);
      return res.status(500).json({ ok: false, error: "Не вдалося створити завдання" });
    }
    res.json({ ok: true, jobId: job.id });

    // далі — у фоні; таблиця опитує /jobs/:id (стан у базі, тож відповість будь-яка машина)
    runRecalc({ wf, pool, payload: v, getPrices, onPricesChanged, publishMode, job });
  });

  app.get("/admin/pricing/jobs/:id", requirePricingKey, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM pricing_jobs WHERE id = $1`, [String(req.params.id)]);
      const j = rows[0];
      if (!j) return res.status(404).json({ ok: false, error: "Job not found" });
      res.set("Cache-Control", "no-store");
      res.json({
        ok: true, state: j.state, done: j.done, total: j.total, results: j.results,
        published: j.published, publishError: j.publish_error, error: j.error,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to read job" });
    }
  });
}
