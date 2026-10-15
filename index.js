import express from "express";
import cors from "cors";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sendOrderEmail, sendOwnerOrderEmail } from "./email.js";

const app = express();

// ================== CORS ==================
const ALLOWED_ORIGINS = [
  "https://cocofloralcouturekyiv.ua",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    // allowedHeaders: ["Content-Type", "Authorization"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  })
);

app.options("*", cors());
app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));
app.use(express.urlencoded({ extended: true }));

// ================== DB (Postgres) ==================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // для Fly Postgres зазвичай треба SSL
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

// ================== Prices (server-side) ==================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRICES_PATH = path.join(__dirname, "price-list.json");
let PRICES = {};

function loadPrices() {
  try {
    const raw = fs.readFileSync(PRICES_PATH, "utf8");
    PRICES = JSON.parse(raw) || {};
  } catch {
    PRICES = {};
  }
}
loadPrices();

// ================== Helpers ==================
const cleanText = (v) => String(v ?? "").trim();
const cleanPhone = (v) => String(v ?? "").replace(/[^\d+]/g, "").trim();

function makeOrderUid(prefix = "wf") {
  return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
}

function buildCart(productsObj) {
  const products = productsObj && typeof productsObj === "object" ? productsObj : {};
  const items = [];
  let total = 0;

  for (const [sku, qtyRaw] of Object.entries(products)) {
    const qty = Math.max(0, parseInt(qtyRaw, 10) || 0);
    if (!qty) continue;

    const product = PRICES[sku];
    if (!product || typeof product !== "object") {
      throw new Error(`Missing product for SKU: ${sku}`);
    }

    const price = Number(product.price);
    if (!Number.isFinite(price)) {
      throw new Error(`Invalid price for SKU: ${sku}`);
    }

    const title = typeof product.title === "string" ? product.title.trim() : "";
    const image = typeof product.image === "string" ? product.image.trim() : "";

    const lineTotal = price * qty;
    total += lineTotal;

    items.push({
      sku,
      qty,
      price,
      lineTotal,
      ...(title ? { title } : {}),
      ...(image ? { image } : {}),
    });
  }

  if (!items.length) throw new Error("Cart is empty");
  return { items, total };
}

async function saveOrderToDB(data, { paymentStatus = "pending", paymentType = "cash" } = {}) {
  const order_uid = makeOrderUid();

  const name = cleanText(data.Name);
  const phone = cleanPhone(data.Phone);
  const email = cleanText(data.Email) || null;

  const delivery = cleanText(data.Delivery) || null;

  // як у твоєму коді, але підстрахуємось під "Adress" з клієнта
  const address = cleanText(data.Address || data.Adress);
  const addressOrNull = address ? address : null;

  const date = cleanText(data.Date) || null;
  const time = cleanText(data.Time) || null;

  const recipient = cleanText(data.Recipient) || null;
  const recipient_select = cleanText(data["Recipient-Select"]) || null;
  const recipient_phone = cleanPhone(data["Recipient-phone"]) || null;

  // ✅ NEW: call-me
  const call_me = cleanText(data["call-me"]) || null;

  if (!name || !phone) throw new Error("Name and Phone are required");

  const cart = buildCart(data.Products);
  const order_data = cart; // { items, total }

  const q = `
    INSERT INTO orders
    (
      order_uid,
      name, phone, email,
      delivery, address,
      date, time,
      payment,
      recipient, recipient_select, recipient_phone,
      call_me,
      payment_status,
      order_data
    )
    VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
    RETURNING id, order_uid, order_number::int AS order_number, created_at
  `;

  const params = [
    order_uid,
    name,
    phone,
    email,
    delivery,
    addressOrNull,
    date,
    time,
    paymentType,
    recipient,
    recipient_select,
    recipient_phone,
    call_me,
    paymentStatus,
    JSON.stringify(order_data),
  ];

  const result = await pool.query(q, params);
  return { ...result.rows[0], total: cart.total };
}

// ================== DB migration (одноразово, безпечно повторювати) ==================
// order_type: "order" (кошик/checkout) | "callback" | "question" | "one_click"
// comment:    текст питання з форми "Задати питання"
// order_number: 8-значний номер для клієнтів (10000001, 10000002, …), спільний для замовлень і заявок
const ORDER_NO_BASE = 10000000; // перший номер = ORDER_NO_BASE + 1

async function migrate() {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    // якщо одночасно стартують кілька машин — міграція виконається по черзі
    await client.query("SELECT pg_advisory_xact_lock(727001)");

    await client.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'order';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS comment TEXT;
      CREATE INDEX IF NOT EXISTS orders_order_type_idx ON orders (order_type);

      CREATE SEQUENCE IF NOT EXISTS orders_number_seq START WITH ${ORDER_NO_BASE + 1};
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number BIGINT;
    `);

    // якщо вже були видані короткі номери (1001, 1002, …) — переводимо їх у 8-значні,
    // зберігаючи порядок: 1001 -> 10000001
    await client.query(`
      UPDATE orders SET order_number = order_number + ${ORDER_NO_BASE - 1000}
      WHERE order_number < ${ORDER_NO_BASE}
        AND (SELECT COALESCE(MAX(order_number), 0) FROM orders) < ${ORDER_NO_BASE}
    `);

    // номери для старих записів — у порядку створення
    const backfill = await client.query(`
      WITH base AS (SELECT COALESCE(MAX(order_number), ${ORDER_NO_BASE}) AS m FROM orders),
           s AS (
             SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
             FROM orders WHERE order_number IS NULL
           )
      UPDATE orders o SET order_number = base.m + s.rn
      FROM s, base
      WHERE o.id = s.id
    `);

    // лічильник не має відставати від уже виданих номерів
    await client.query(`
      SELECT setval('orders_number_seq', GREATEST(
        (SELECT COALESCE(MAX(order_number), ${ORDER_NO_BASE}) FROM orders),
        (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM orders_number_seq)
      ), true);
      ALTER TABLE orders ALTER COLUMN order_number SET DEFAULT nextval('orders_number_seq');
      ALTER SEQUENCE orders_number_seq OWNED BY orders.order_number;
      CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_uidx ON orders (order_number);
    `);

    await client.query("COMMIT");
    console.log(`DB migration OK (order_number backfilled: ${backfill.rowCount})`);
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("DB migration failed:", err?.message || err);
  } finally {
    client?.release();
  }
}

// чекаємо міграцію до старту сервера (але не довше 20 с, щоб не зависнути)
await Promise.race([migrate(), new Promise((r) => setTimeout(r, 20000))]);

// ================== LEADS (передзвоніть / питання / в 1 клік) ==================
const LEAD_TYPES = {
  callback: { prefix: "cb" },
  question: { prefix: "q" },
  one_click: { prefix: "oc" },
};

// Аліаси: як називаються попапи у Webflow -> тип у базі
const LEAD_ALIASES = {
  call: "callback",
  callback: "callback",
  question: "question",
  "one-touch": "one_click",
  one_click: "one_click",
  "one-click": "one_click",
};

const normTitle = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const parsePrice = (s) => {
  const n = Number(String(s ?? "").replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const imageKey = (url) => {
  try {
    const last = new URL(String(url)).pathname.split("/").pop() || "";
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return "";
  }
};

// Шукаємо товар у price-list.json: спершу за фото (воно унікальне),
// далі за назвою + ціною, далі просто за назвою.
function findProduct({ name, price, image }) {
  const entries = Object.entries(PRICES);
  const imgKey = imageKey(image);
  if (imgKey) {
    const hit = entries.find(([, p]) => imageKey(p?.image) === imgKey);
    if (hit) return hit;
  }
  const t = normTitle(name);
  if (!t) return null;
  const byTitle = entries.filter(([, p]) => normTitle(p?.title) === t);
  if (!byTitle.length) return null;
  const n = parsePrice(price);
  return (n && byTitle.find(([, p]) => Number(p.price) === n)) || byTitle[0];
}

function buildOneClickData(data) {
  // з фронта: ProductName, ProductPrice, ProductImage + сирий рядок Product ("Назва - 1 400 ₴")
  let name = cleanText(data.ProductName);
  let price = cleanText(data.ProductPrice);
  const raw = cleanText(data.Product);
  if (!name && raw) {
    const m = raw.match(/^(.*?)\s+-\s+([\d\s.,]+)\s*(₴|грн|UAH)?$/i);
    name = m ? m[1] : raw;
    if (!price && m) price = m[2];
  }

  const found = findProduct({ name, price, image: data.ProductImage });
  if (found) {
    const [sku, p] = found;
    const unit = Number(p.price);
    return {
      items: [{
        sku, qty: 1, price: unit, lineTotal: unit,
        ...(p.title ? { title: p.title.trim() } : {}),
        ...(p.image ? { image: p.image.trim() } : {}),
      }],
      total: unit,
    };
  }

  // товар не знайдено в прайсі — зберігаємо те, що прийшло з сайту, з позначкою
  const unit = parsePrice(price) || 0;
  return {
    items: [{
      sku: null, qty: 1, price: unit, lineTotal: unit,
      ...(name ? { title: name } : {}),
      ...(data.ProductImage ? { image: cleanText(data.ProductImage) } : {}),
    }],
    total: unit,
    unverified: true, // ціну взято з фронта, не з price-list.json
  };
}

async function saveLeadToDB(type, data) {
  const name = cleanText(data.Name).slice(0, 256);
  const phone = cleanPhone(data.Phone);
  if (!name || !phone) throw new Error("Name and Phone are required");
  if (phone.replace(/\D/g, "").length < 10) throw new Error("Invalid phone");

  const question = type === "question" ? cleanText(data.Question).slice(0, 5000) : "";
  if (type === "question" && !question) throw new Error("Question is required");

  const order_data =
    type === "one_click"
      ? buildOneClickData(data)
      : { items: [], total: 0 };

  order_data.source = {
    form: type,
    page: cleanText(data.Page).slice(0, 500) || null,
  };
  if (question) order_data.question = question;

  const order_uid = makeOrderUid(LEAD_TYPES[type].prefix);

  const { rows } = await pool.query(
    `INSERT INTO orders
       (order_uid, name, phone, payment, payment_status, call_me, order_type, comment, order_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     RETURNING id, order_uid, order_number::int AS order_number, created_at`,
    [
      order_uid,
      name,
      phone,
      "lead",   // оплати ще немає — менеджер уточнить
      "new",    // статус обробки заявки
      "false",  // call_me = чекбокс "Не телефонуйте мені"; заявка = клієнт чекає дзвінка
      type,
      question || null,
      JSON.stringify(order_data),
    ]
  );
  return rows[0];
}

// Простий антиспам: не більше 8 заявок з однієї IP за 10 хв
const leadHits = new Map();
function leadRateLimit(req, res, next) {
  const ip = req.headers["fly-client-ip"] || req.ip || "unknown";
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const hits = (leadHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (hits.length >= 8) {
    return res.status(429).json({ ok: false, error: "Too many requests" });
  }
  hits.push(now);
  leadHits.set(ip, hits);
  if (leadHits.size > 5000) {
    for (const [k, v] of leadHits) if (!v.some((t) => now - t < windowMs)) leadHits.delete(k);
  }
  next();
}

async function reserveOrderNumber() {
  try {
    const { rows } = await pool.query(`SELECT nextval('orders_number_seq') AS n`);
    return Number(rows[0].n);
  } catch (err) {
    console.error("reserveOrderNumber failed:", err?.message || err);
    return null; // номер призначить БД при вставці
  }
}

// ================== MONO (card) helpers ==================
// ВАЖЛИВО: amount/sum/total для mono — в копійках, ccy: 980 (UAH)

function toKopiyky(n) {
  // PRICES у гривнях -> mono треба копійки
  return Math.round(Number(n) * 100);
}

function buildCartForMono(cart) {
  const basketOrder = cart.items.map((it) => {
    const sum = toKopiyky(it.price);
    const total = sum * it.qty;

    return {
      name: it.title || String(it.sku),
      qty: it.qty,
      sum,
      total,
      code: String(it.sku),
      unit: "шт.",
      ...(it.image ? { icon: it.image } : {}),
    };
  });

  const amount = basketOrder.reduce((acc, x) => acc + x.total, 0);
  return { amount, basketOrder };
}

function getMonoToken() {
  // ЗАРАЗ: тестуємо -> MONO_TOKEN_TEST
  // ЗАРАЗ: прод -> MONO_TOKEN_PROD
  const t = process.env.MONO_TOKEN_PROD;
  if (!t) throw new Error("MONO_TOKEN_PROD is missing");
  return t;
}

async function createMonoInvoice({ order_uid, order_number, data, cart }) {
  const MONO_TOKEN = getMonoToken();

  if (!process.env.MONO_REDIRECT_URL) throw new Error("MONO_REDIRECT_URL is missing");
  const webHookUrl = process.env.MONO_WEBHOOK_URL || undefined;

  const { amount, basketOrder } = buildCartForMono(cart);

  const payload = {
    amount, // копійки
    ccy: 980, // UAH
    merchantPaymInfo: {
      reference: order_uid,
      destination: order_number
        ? `CoCo Floral Couture, замовлення №${order_number}`
        : "CoCo Floral Couture",
      comment: order_number ? `Замовлення №${order_number}` : `Order ${order_uid}`,
      customerEmails: data.Email ? [String(data.Email).trim()] : [],
      basketOrder,
    },
    redirectUrl: process.env.MONO_REDIRECT_URL,
    ...(webHookUrl ? { webHookUrl } : {}),
    paymentType: "debit",
    validity: 3600, // сек
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);

  let resp, json;
  try {
    resp = await fetch("https://api.monobank.ua/api/merchant/invoice/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Token": MONO_TOKEN,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    json = await resp.json().catch(() => ({}));
  } finally {
    clearTimeout(t);
  }

  if (!resp.ok) {
    throw new Error(`Mono invoice error: HTTP ${resp.status} ${JSON.stringify(json)}`);
  }

  const invoiceId = json?.invoiceId;
  const pageUrl = json?.pageUrl;
  if (!invoiceId || !pageUrl) throw new Error("Mono invoice error: missing invoiceId/pageUrl");

  return { invoiceId, pageUrl, amount };
}

async function saveCardOrderToDB(data, { order_uid, order_number, invoiceId, pageUrl, amountKop }) {
  // Запис аналогічний saveOrderToDB, але:
  // - order_uid беремо той самий, що передали в mono (reference)
  // - payment = "card"
  // - payment_status = "pending"
  // - mono дані кладемо в order_data.mono (щоб не міняти схему таблиці)

  const name = cleanText(data.Name);
  const phone = cleanPhone(data.Phone);
  const email = cleanText(data.Email) || null;

  const delivery = cleanText(data.Delivery) || null;
  const address = cleanText(data.Address || data.Adress);
  const addressOrNull = address ? address : null;

  const date = cleanText(data.Date) || null;
  const time = cleanText(data.Time) || null;

  const recipient = cleanText(data.Recipient) || null;
  const recipient_select = cleanText(data["Recipient-Select"]) || null;
  const recipient_phone = cleanPhone(data["Recipient-phone"]) || null;

  // ✅ NEW: call-me
  const call_me = cleanText(data["call-me"]) || null;

  if (!name || !phone) throw new Error("Name and Phone are required");

  const cart = buildCart(data.Products);

  const order_data = {
    ...cart,
    mono: {
      invoiceId,
      amount: Number((amountKop / 100).toFixed(2)),
    },
  };

  const q = `
    INSERT INTO orders
    (
      order_uid,
      name, phone, email,
      delivery, address,
      date, time,
      payment,
      recipient, recipient_select, recipient_phone,
      call_me,
      payment_status,
      order_data,
      order_number
    )
    VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,
     COALESCE($16::bigint, nextval('orders_number_seq')))
    RETURNING id, order_uid, order_number::int AS order_number, created_at
  `;

  const params = [
    order_uid,
    name,
    phone,
    email,
    delivery,
    addressOrNull,
    date,
    time,
    "card",
    recipient,
    recipient_select,
    recipient_phone,
    call_me,
    "pending",
    JSON.stringify(order_data),
    order_number || null,
  ];

  const result = await pool.query(q, params);
  return { ...result.rows[0], total: cart.total, invoiceId, pageUrl };
}

// ================== ADMIN middleware ==================
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({ ok: false, error: "ADMIN_KEY missing" });
  }
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ================== Routes ==================
app.get("/", (req, res) => {
  res.send("OK: server is running");
});

// ✅ WEBHOOK від mono (оновлення статусу оплати)
// Постав в secrets: MONO_WEBHOOK_URL = https://coco-floral.fly.dev/mono/webhook
app.post("/mono-webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const invoiceId = body.invoiceId;
    const status = body.status;

    if (!invoiceId || !status) {
      return res.status(400).json({ ok: false, error: "Missing invoiceId/status" });
    }

    let newStatus = "pending";
    if (status === "success") newStatus = "success";
    else if (["failure", "expired", "reversed", "canceled"].includes(status)) newStatus = "failed";
    else newStatus = String(status);

    // RETURNING лише якщо статус справді змінився — mono може надіслати
    // той самий вебхук кілька разів, а листи мають піти один раз
    const { rows } = await pool.query(
      `UPDATE orders SET payment_status = $2
       WHERE order_data->'mono'->>'invoiceId' = $1
         AND payment_status IS DISTINCT FROM $2
       RETURNING *`,
      [String(invoiceId), newStatus]
    );

    // ✅ відправляємо листи (клієнту і власнику) після успішної оплати
    if (newStatus === "success" && rows[0]) {
      sendOrderEmail(rows[0]).catch(console.error);
      sendOwnerOrderEmail(rows[0]).catch(console.error);
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/order", async (req, res) => {
  const data = req.body;

  if (!data || !data.Payment) {
    return res.status(400).json({
      ok: false,
      error: "Payment field is required",
    });
  }

  // ====== ГІЛКА 1: ОПЛАТА ГОТІВКОЮ ======
 if (data.Payment === "cash") {
  try {
    const saved = await saveOrderToDB(data, {
      paymentStatus: "cash",
      paymentType: "cash",
    });

    const emailOrder = {
      ...saved,
      name: data.Name,
      phone: data.Phone,
      email: data.Email,
      delivery: data.Delivery,
      address: data.Address || data.Adress,
      date: data.Date,
      time: data.Time,
      payment: "cash",
      payment_status: "cash",
      recipient: data.Recipient,
      recipient_select: data["Recipient-Select"],
      recipient_phone: data["Recipient-phone"],
      call_me: data["call-me"],
      order_data: buildCart(data.Products),
    };
    sendOrderEmail(emailOrder).catch(console.error);
    sendOwnerOrderEmail(emailOrder).catch(console.error);

    return res.json({
      payment: "cash",
      order_number: saved.order_number,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}

  // ✅ NEW: ГІЛКА 1.1: ОПЛАТА ПЕРЕКАЗОМ (як cash)
 if (data.Payment === "transfer") {
  try {
    const saved = await saveOrderToDB(data, {
      paymentStatus: "transfer",
      paymentType: "transfer",
    });

    const emailOrder = {
      ...saved,
      name: data.Name,
      phone: data.Phone,
      email: data.Email,
      delivery: data.Delivery,
      address: data.Address || data.Adress,
      date: data.Date,
      time: data.Time,
      payment: "transfer",
      payment_status: "transfer",
      recipient: data.Recipient,
      recipient_select: data["Recipient-Select"],
      recipient_phone: data["Recipient-phone"],
      call_me: data["call-me"],
      order_data: buildCart(data.Products),
    };
    sendOrderEmail(emailOrder).catch(console.error);
    sendOwnerOrderEmail(emailOrder).catch(console.error);

    return res.json({
      payment: "transfer",
      order_number: saved.order_number,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}

  // ====== ГІЛКА 2: ОПЛАТА КАРТОЮ (MONO) ======
  if (data.Payment === "card") {
    try {
      const order_uid = makeOrderUid();
      const cart = buildCart(data.Products);
      // резервуємо короткий номер заздалегідь — він потрапить у призначення платежу mono
      const order_number = await reserveOrderNumber();
      const invoice = await createMonoInvoice({ order_uid, order_number, data, cart });
      await saveCardOrderToDB(data, {
        order_uid,
        order_number,
        invoiceId: invoice.invoiceId,
        pageUrl: invoice.pageUrl,
        amountKop: invoice.amount,
      });
      return res.json({
        ok: true,
        payment: "card",
        order_number,
        pageUrl: invoice.pageUrl,
        // paymentId: invoice.invoiceId,
      });
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  }

  return res.status(400).json({
    ok: false,
    error: "Unknown payment type",
  });
});

// ✅ Заявки з форм: "Передзвоніть мені", "Задати питання", "Замовити в 1 клік"
// body: { type: "call" | "question" | "one-touch", Name, Phone, Question?, Product?, ProductName?, ProductPrice?, ProductImage?, Page? }
app.post("/lead", leadRateLimit, async (req, res) => {
  try {
    const data = req.body || {};
    const type = LEAD_ALIASES[cleanText(data.type)];
    if (!type) return res.status(400).json({ ok: false, error: "Unknown lead type" });

    const saved = await saveLeadToDB(type, data);
    return res.json({ ok: true, type, order_number: saved.order_number, order_uid: saved.order_uid });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

// ✅ Зміна статусу заявки з адмінки: { status: "new" | "done" }
// Працює лише для заявок (order_type != 'order'), статуси оплати замовлень не чіпає.
app.post("/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const status = cleanText(req.body?.status);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    if (!["new", "done"].includes(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const { rows } = await pool.query(
      `UPDATE orders SET payment_status = $2
       WHERE id = $1 AND order_type <> 'order'
       RETURNING id, order_uid, order_number::int AS order_number, payment_status`,
      [id, status]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Lead not found" });

    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to update status" });
  }
});

// GET /orders?type=order|callback|question|one_click&limit=200
app.get("/orders", requireAdmin, async (req, res) => {
  try {
    const type = cleanText(req.query.type);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);

    const params = [limit];
    let where = "";
    if (type) {
      params.push(type);
      where = "WHERE order_type = $2";
    }

    const { rows } = await pool.query(`
      SELECT
        id,
        order_number::int AS order_number,
        order_uid,
        order_type,
        name,
        phone,
        email,
        delivery,
        address,
        date,
        time,
        payment,
        payment_status,
        order_data,
        recipient,
        recipient_select,
        recipient_phone,
        call_me,
        comment,
        created_at
      FROM public.orders
      ${where}
      ORDER BY created_at DESC
      LIMIT $1
    `, params);

    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to fetch orders" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("Server running on port", PORT);
});
