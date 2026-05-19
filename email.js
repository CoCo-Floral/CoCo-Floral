// ================== EMAIL (Resend) ==================
// npm install resend
// fly secrets set RESEND_API_KEY=re_xxxx RESEND_FROM="CoCo Floral Couture <orders@coco-floral.shop>"

import { Resend } from "resend";

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  return new Resend(key);
}

function formatPrice(n) {
  return Number(n).toLocaleString("uk-UA") + " ₴";
}

function formatDate(isoStr) {
  if (!isoStr) return "—";
  return new Date(isoStr).toLocaleString("uk-UA", {
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function buildItemsHtml(items = []) {
  return items.map(it => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0ebe6;vertical-align:middle;">
        ${it.image
          ? `<img src="${it.image}" alt="${it.title || it.sku}" width="54" height="54"
               style="border-radius:8px;object-fit:cover;display:block;">`
          : `<div style="width:54px;height:54px;border-radius:8px;background:#f5f0eb;display:flex;align-items:center;justify-content:center;font-size:20px;">🌸</div>`
        }
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0ebe6;vertical-align:middle;">
        <div style="font-family:'Georgia',serif;color:#2c1a0e;font-size:14px;font-weight:600;line-height:1.3;">${it.title || it.sku}</div>
        <div style="color:#a08070;font-size:12px;margin-top:2px;">Арт: ${it.sku}</div>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0ebe6;vertical-align:middle;text-align:center;color:#6b4226;font-size:14px;">
        ${it.qty} шт.
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0ebe6;vertical-align:middle;text-align:right;color:#2c1a0e;font-size:14px;font-weight:600;white-space:nowrap;">
        ${formatPrice(it.lineTotal)}
      </td>
    </tr>
  `).join("");
}

function paymentLabel(p) {
  if (p === "cash") return "Готівка";
  if (p === "card") return "Картка (Monobank)";
  if (p === "transfer") return "Переказ";
  return p || "—";
}

function row(label, value) {
  if (!value || value === "—" || value === "null") return "";
  return `
    <tr>
      <td style="padding:6px 0;color:#a08070;font-size:13px;width:45%;vertical-align:top;">${label}</td>
      <td style="padding:6px 0;color:#2c1a0e;font-size:13px;font-weight:500;vertical-align:top;">${value}</td>
    </tr>`;
}

export function buildOrderEmailHtml(order) {
  const {
    order_uid, name, phone, email,
    delivery, address, date, time,
    payment, payment_status,
    recipient, recipient_select, recipient_phone,
    call_me, created_at, order_data,
  } = order;

  const items = order_data?.items || [];
  const total = order_data?.total ?? 0;

  const deliveryLabel = delivery === "delivery" ? "Доставка" : delivery === "pickup" ? "Самовивіз" : (delivery || "—");
  const recipientLabel = recipient_select === "self" ? "Собі" : recipient_select === "other" ? "Іншій людині" : (recipient_select || "—");
  const callMeLabel = call_me === "yes" || call_me === "true" ? "Так" : call_me === "no" ? "Ні" : (call_me || "—");

  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Підтвердження замовлення</title>
</head>
<body style="margin:0;padding:0;background:#fdf8f4;font-family:'Helvetica Neue',Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf8f4;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- HEADER -->
  <tr>
    <td style="background:linear-gradient(135deg,#3b1f0e 0%,#6b3a24 60%,#9c5a3c 100%);
               border-radius:16px 16px 0 0;padding:40px 40px 32px;text-align:center;">
      <div style="font-size:32px;margin-bottom:10px;">🌸</div>
      <div style="font-family:'Georgia',serif;color:#f5e6d8;font-size:26px;font-weight:400;
                  letter-spacing:0.5px;line-height:1.2;">
        CoCo Floral Couture
      </div>
      <div style="color:#c9a88a;font-size:13px;margin-top:6px;letter-spacing:2px;text-transform:uppercase;">
        Підтвердження замовлення
      </div>
    </td>
  </tr>

  <!-- ORDER UID BADGE -->
  <tr>
    <td style="background:#fff9f5;padding:20px 40px;text-align:center;border-left:1px solid #eeddd0;border-right:1px solid #eeddd0;">
      <span style="display:inline-block;background:#f5ede5;border:1px solid #ddc4b0;
                   border-radius:100px;padding:8px 24px;
                   font-size:13px;color:#7a4a2e;letter-spacing:0.5px;">
        Замовлення № <strong>${order_uid}</strong>
      </span>
      <div style="color:#a08070;font-size:12px;margin-top:8px;">
        ${formatDate(created_at)}
      </div>
    </td>
  </tr>

  <!-- GREETING -->
  <tr>
    <td style="background:#fff9f5;padding:24px 40px 8px;
               border-left:1px solid #eeddd0;border-right:1px solid #eeddd0;">
      <p style="margin:0;font-family:'Georgia',serif;color:#3b1f0e;font-size:20px;font-weight:400;">
        Дякуємо, ${name}! 💐
      </p>
      <p style="margin:10px 0 0;color:#7a5a48;font-size:14px;line-height:1.6;">
        Ваше замовлення успішно прийнято. Ми вже починаємо його готувати — незабаром зв'яжемося з вами для підтвердження деталей.
      </p>
    </td>
  </tr>

  <!-- DIVIDER -->
  <tr>
    <td style="background:#fff9f5;padding:20px 40px 0;border-left:1px solid #eeddd0;border-right:1px solid #eeddd0;">
      <hr style="border:none;border-top:1px solid #eeddd0;margin:0;">
    </td>
  </tr>

  <!-- ITEMS TABLE -->
  <tr>
    <td style="background:#fff9f5;padding:24px 40px;border-left:1px solid #eeddd0;border-right:1px solid #eeddd0;">
      <div style="font-family:'Georgia',serif;color:#3b1f0e;font-size:16px;margin-bottom:14px;">
        🛒 Склад замовлення
      </div>
      <table width="100%" cellpadding="0" cellspacing="0"
             style="border-collapse:collapse;border:1px solid #eeddd0;border-radius:10px;overflow:hidden;">
        <thead>
          <tr style="background:#fdf0e8;">
            <th style="padding:10px 12px;text-align:left;color:#a08070;font-size:11px;
                       font-weight:600;letter-spacing:1px;text-transform:uppercase;width:60px;"></th>
            <th style="padding:10px 12px;text-align:left;color:#a08070;font-size:11px;
                       font-weight:600;letter-spacing:1px;text-transform:uppercase;">Позиція</th>
            <th style="padding:10px 12px;text-align:center;color:#a08070;font-size:11px;
                       font-weight:600;letter-spacing:1px;text-transform:uppercase;">Кількість</th>
            <th style="padding:10px 12px;text-align:right;color:#a08070;font-size:11px;
                       font-weight:600;letter-spacing:1px;text-transform:uppercase;">Сума</th>
          </tr>
        </thead>
        <tbody>
          ${buildItemsHtml(items)}
        </tbody>
        <tfoot>
          <tr style="background:#fdf0e8;">
            <td colspan="3" style="padding:14px 12px;font-family:'Georgia',serif;
                                   color:#3b1f0e;font-size:15px;font-weight:600;">
              Разом
            </td>
            <td style="padding:14px 12px;text-align:right;font-family:'Georgia',serif;
                       color:#6b3a24;font-size:17px;font-weight:700;white-space:nowrap;">
              ${formatPrice(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </td>
  </tr>

  <!-- ORDER DETAILS -->
  <tr>
    <td style="background:#fff9f5;padding:0 40px 24px;border-left:1px solid #eeddd0;border-right:1px solid #eeddd0;">
      <div style="font-family:'Georgia',serif;color:#3b1f0e;font-size:16px;margin-bottom:14px;">
        📋 Деталі замовлення
      </div>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${row("Ім'я", name)}
        ${row("Телефон", phone)}
        ${row("Email", email)}
        ${row("Спосіб отримання", deliveryLabel)}
        ${row("Адреса доставки", address)}
        ${row("Дата", date)}
        ${row("Час", time)}
        ${row("Оплата", paymentLabel(payment))}
        ${row("Статус оплати", payment_status === "success" ? "✅ Оплачено" : payment_status === "cash" ? "💵 Готівка при отриманні" : payment_status === "transfer" ? "🔄 Переказ" : payment_status)}
        ${row("Отримувач", recipientLabel)}
        ${recipient_select === "other" ? row("Ім'я отримувача", recipient) : ""}
        ${recipient_select === "other" ? row("Телефон отримувача", recipient_phone) : ""}
        ${row("Передзвонити мені", callMeLabel)}
      </table>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:linear-gradient(135deg,#3b1f0e 0%,#6b3a24 100%);
               border-radius:0 0 16px 16px;padding:28px 40px;text-align:center;">
      <p style="margin:0 0 10px;color:#c9a88a;font-size:13px;line-height:1.6;">
        Маєте питання? Пишіть або телефонуйте нам — ми завжди раді допомогти.
      </p>
      <a href="https://coco-floral.shop" style="color:#f5e6d8;font-size:13px;text-decoration:none;
         border-bottom:1px solid rgba(245,230,216,0.4);">coco-floral.shop</a>
      <p style="margin:16px 0 0;color:#7a5540;font-size:11px;">
        © CoCo Floral Couture • Київ, Україна
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export async function sendOrderEmail(order) {
  if (!order.email) return; // немає email — пропускаємо

  const resend = getResend();
  const from = process.env.RESEND_FROM || "CoCo Floral Couture <orders@coco-floral.shop>";

  const { error } = await resend.emails.send({
    from,
    to: [order.email],
    subject: `🌸 Ваше замовлення #${order.order_uid} прийнято — CoCo Floral Couture`,
    html: buildOrderEmailHtml(order),
  });

  if (error) {
    console.error("Resend error:", error);
  }
}
