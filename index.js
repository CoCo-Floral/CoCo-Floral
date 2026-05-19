import express from "express";
import cors from "cors";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sendOrderEmail } from "./email.js";

const app = express();

// ================== CORS ==================
const ALLOWED_ORIGINS = [
  "https://coco-floral.shop",
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

function makeOrderUid() {
  return "wf_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
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
    RETURNING id, order_uid, created_at
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

async function createMonoInvoice({ order_uid, data, cart }) {
  const MONO_TOKEN = getMonoToken();

  if (!process.env.MONO_REDIRECT_URL) throw new Error("MONO_REDIRECT_URL is missing");
  const webHookUrl = process.env.MONO_WEBHOOK_URL || undefined;

  const { amount, basketOrder } = buildCartForMono(cart);

  const payload = {
    amount, // копійки
    ccy: 980, // UAH
    merchantPaymInfo: {
      reference: order_uid,
      destination: "CoCo Floral Couture",
      comment: `Order ${order_uid}`,
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

async function saveCardOrderToDB(data, { order_uid, invoiceId, pageUrl, amountKop }) {
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
      order_data
    )
    VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
    RETURNING id, order_uid, created_at
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

    await pool.query(
      `UPDATE orders SET payment_status = $2
       WHERE order_data->'mono'->>'invoiceId' = $1`,
      [String(invoiceId), newStatus]
    );

    // ✅ відправляємо лист після успішної оплати
    if (newStatus === "success") {
      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE order_data->'mono'->>'invoiceId' = $1`,
        [String(invoiceId)]
      );
      if (rows[0]) {
        sendOrderEmail(rows[0]).catch(console.error);
      }
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

    sendOrderEmail({
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
    }).catch(console.error);

    return res.json({
      payment: "cash",
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

    sendOrderEmail({
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
    }).catch(console.error);

    return res.json({
      payment: "transfer",
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
      const invoice = await createMonoInvoice({ order_uid, data, cart });
      await saveCardOrderToDB(data, {
        order_uid,
        invoiceId: invoice.invoiceId,
        pageUrl: invoice.pageUrl,
        amountKop: invoice.amount,
      });
      return res.json({
        ok: true,
        payment: "card",
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

app.get("/orders", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        order_uid,
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
        created_at
      FROM public.orders
      ORDER BY created_at DESC
      LIMIT 200
    `);

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
