/** @OnlyCurrentDoc */

/**
 * CoCo Floral — склад букетів і ціни
 * ------------------------------------------------------------
 * Встановлення (один раз):
 *   1. Створи порожню Google Таблицю.
 *   2. Розширення → Apps Script, видали все, що там є, встав цей код, збережи.
 *   3. Угорі обери функцію setupSheet → «Виконати», дай доступ.
 *   4. Онови сторінку таблиці — з'явиться меню «CoCo».
 *
 * Як влаштовано «Склад»:
 *   • рядок з SKU — це «шапка» букета (сірий, жирний, з чорною лінією зверху);
 *   • рядки під ним без SKU — його інгредієнти;
 *   • наступний рядок з SKU починає новий букет.
 * Формули в колонках E, F, G, J, K — ARRAYFORMULA на всю колонку,
 * тому вставлені рядки рахуються самі, нічого копіювати не треба.
 */

const CFG = {
  SHEET_INGR: 'Інгредієнти',
  SHEET_COMP: 'Склад',
  SHEET_HELP: 'Як користуватись',
  PACKAGING_PERCENT: 10, // послуга упаковки, % (лише для попередньої ціни; бекенд рахує сам)
  ROUND_TO: 50,          // округлення вгору, грн
  SKU_PREFIX: 'BQ-',     // які товари з сайту вважаються букетами
  POLL_SECONDS: 3,
  POLL_MAX_SECONDS: 300,
};

// Колонки аркуша «Склад»
const C = { SKU: 1, TITLE: 2, INGR: 3, QTY: 4, UNIT: 5, SUM: 6, PRICE: 7, SITE: 8, STATUS: 9, SKU_AUTO: 10, BLOCK: 11 };
const LAST_VISIBLE = C.STATUS; // I
const LAST_COL = C.BLOCK;      // K

const COLORS = {
  head: '#111111', headText: '#FFFFFF',   // шапка таблиці
  block: '#E4E4E4', blockText: '#111111', // рядок букета
  band: '#F6F6F6',                        // інгредієнти кожного другого букета
  muted: '#6B6B6B',                       // формули (сірий текст)
  border: '#111111',                      // лінія над букетом
  errBg: '#FDE2E1', errText: '#B3261E',   // помилки — єдиний колір поза гамою
};

// ================== Меню ==================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('CoCo')
    .addItem('Оновити ціни на сайті', 'updatePrices')
    .addItem('Підтягнути букети з сайту', 'pullBouquets')
    .addItem('Синхронізувати ціни інших товарів з Webflow', 'syncPrices')
    .addSeparator()
    .addItem('Додати інгредієнт під виділеним рядком', 'insertIngredientRow')
    .addItem('Перевірити склад', 'checkComposition')
    .addSeparator()
    .addItem('Налаштування підключення', 'configureConnection')
    .addItem('Перебудувати оформлення', 'setupSheet')
    .addToUi();
}

// ================== Налаштування таблиці ==================
function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  const ingr = getOrCreateSheet_(ss, CFG.SHEET_INGR, 0);
  const comp = getOrCreateSheet_(ss, CFG.SHEET_COMP, 1);
  const help = getOrCreateSheet_(ss, CFG.SHEET_HELP, 2);
  detectSeparator_(comp);

  setupIngredients_(ingr);
  setupComposition_(comp);
  setupHelp_(help);
  applyBlockBorders_(comp);

  ss.setActiveSheet(comp);
  SpreadsheetApp.flush();
  ss.toast('Таблицю налаштовано', 'CoCo', 5);
  try { onOpen(); } catch (e) { /* запуск з редактора — меню з'явиться після оновлення сторінки */ }
}

function getOrCreateSheet_(ss, name, index) {
  const existing = ss.getSheetByName(name);
  if (existing) return existing;
  const sheets = ss.getSheets();
  const ours = [CFG.SHEET_INGR, CFG.SHEET_COMP, CFG.SHEET_HELP];
  // порожній аркуш за замовчуванням («Аркуш1» / «Sheet1») — просто перейменовуємо
  if (index === 0 && sheets.length === 1 && sheets[0].getLastRow() === 0 && !ours.includes(sheets[0].getName())) {
    return sheets[0].setName(name);
  }
  return ss.insertSheet(name, Math.min(index, sheets.length));
}

function setupIngredients_(sh) {
  sh.getRange(1, 1, 1, 3).setValues([['Назва', 'Ціна за шт, ₴', 'У скількох SKU']]);
  styleHeader_(sh.getRange(1, 1, 1, 3));
  sh.setFrozenRows(1);

  if (lastDataRow_(sh, 2) < 2) {
    const demo = [
      ['Троянда мікс', 95], ['Гортензія місцева', 250], ['Еустома', 110], ['Жоржина', 120],
      ['Куеркус', 60], ['Міскантус', 50], ['Солідаго', 45], ['Евкаліпт', 50],
    ];
    sh.getRange(2, 1, demo.length, 2).setValues(demo);
  }

  // формула живе в заголовку (C1), тому будь-який рядок з даними можна видаляти
  sh.getRange('C2:C').clearContent();
  sh.getRange('C1').setFormula(f_(
    `=ARRAYFORMULA({"У скількох SKU";IF(A2:A="","",COUNTIF('${CFG.SHEET_COMP}'!C2:C,A2:A))})`
  ));

  sh.getRange('B2:B').setNumberFormat('#,##0.##')
    .setDataValidation(SpreadsheetApp.newDataValidation()
      .requireNumberGreaterThan(0).setAllowInvalid(false)
      .setHelpText('Ціна за 1 шт, грн').build());
  sh.getRange('C2:C').setFontColor(COLORS.muted);

  sh.setColumnWidth(1, 240);
  sh.setColumnWidth(2, 120);
  sh.setColumnWidth(3, 130);

  sh.setConditionalFormatRules([
    rule_(sh, 'A2:A', '=AND($A2<>"",COUNTIF($A$2:$A,$A2)>1)', COLORS.errBg, COLORS.errText, true), // назва повторюється
    rule_(sh, 'B2:B', '=AND($A2<>"",$B2="")', COLORS.errBg, null, false),                           // немає ціни
  ]);

  protect_(sh.getRange('C1:C'), 'coco:ingr-formula');
}

function setupComposition_(sh) {
  sh.getRange(1, 1, 1, LAST_COL).setValues([[
    'SKU', 'Букет', 'Інгредієнт', 'К-сть', 'Ціна за шт', 'Сума', 'Ціна букета', 'На сайті', 'Статус', '_sku', '_блок',
  ]]);
  styleHeader_(sh.getRange(1, 1, 1, LAST_COL));
  sh.setFrozenRows(1);

  if (lastDataRow_(sh, 4) < 2) {
    // Тестові букети з вигаданими SKU — видали їх перед першим реальним оновленням
    const demo = [
      ['BQ-TEST-M', 'Тестовий монобукет', '', ''],
      ['', '', 'Троянда мікс', 17],
      ['', '', 'Евкаліпт', 5],
      ['BQ-TEST-S', 'Тестовий монобукет', '', ''],
      ['', '', 'Троянда мікс', 9],
      ['', '', 'Евкаліпт', 3],
      ['BQ-TEST2-M', 'Тестовий збірний букет', '', ''],
      ['', '', 'Троянда мікс', 17],
      ['', '', 'Гортензія місцева', 3],
      ['', '', 'Еустома', 6],
      ['', '', 'Жоржина', 8],
      ['', '', 'Куеркус', 7],
      ['', '', 'Міскантус', 5],
      ['', '', 'Солідаго', 6],
    ];
    sh.getRange(2, 1, demo.length, 4).setValues(demo);
  }

  // Формули: англійські назви функцій; роздільник аргументів підставляє f_() під локаль таблиці
  // формули живуть у заголовку (рядок 1), тому будь-який рядок з даними можна видаляти
  sh.getRange('E2:G').clearContent();
  sh.getRange('J2:K').clearContent();
  const ING = `'${CFG.SHEET_INGR}'`;
  const mult = 100 + CFG.PACKAGING_PERCENT;

  // ціна за шт з довідника; 1/(1/x) дає помилку і для «немає», і для порожньої ціни
  sh.getRange('E1').setFormula(f_(
    `=ARRAYFORMULA({"Ціна за шт";IF(C2:C="","",IFERROR(1/(1/VLOOKUP(C2:C,${ING}!A2:B,2,FALSE)),"! немає ціни"))})`
  ));
  sh.getRange('F1').setFormula(f_(
    `=ARRAYFORMULA({"Сума";IF(C2:C="","",IF(D2:D="","! к-сть",IFERROR(D2:D*E2:E,"!")))})`
  ));
  // SKU протягується вниз на всі рядки інгредієнтів букета
  sh.getRange('J1').setFormula(f_(
    `=ARRAYFORMULA({"_sku";IF((A2:A="")*(C2:C=""),"",IFERROR(LOOKUP(ROW(A2:A),ROW(A2:A)/(A2:A<>""),A2:A),""))})`
  ));
  // порядковий номер букета — для чергування фону
  sh.getRange('K1').setFormula(f_(
    `=ARRAYFORMULA({"_блок";IF(J2:J="","",IFERROR(MATCH(J2:J,FILTER(A2:A,A2:A<>""),0),""))})`
  ));
  // попередня ціна: сума × 1.10, вгору до 50; множимо на 110/100, а не 1.1 — без похибки дробів
  sh.getRange('G1').setFormula(f_(
    `=ARRAYFORMULA({"Ціна букета";IF(A2:A="","",` +
    `IF(COUNTIFS(J2:J,A2:A,F2:F,"!*")>0,"! перевір склад",` +
    `IF(SUMIF(J2:J,A2:A,F2:F)=0,"— додай склад",` +
    `CEILING(SUMIF(J2:J,A2:A,F2:F)*${mult}/100,${CFG.ROUND_TO}))))})`
  ));

  const ingrRange = sh.getParent().getSheetByName(CFG.SHEET_INGR).getRange('A2:A');
  sh.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ingrRange, true).setAllowInvalid(false)
    .setHelpText('Обери інгредієнт зі списку (аркуш «Інгредієнти»)').build());
  sh.getRange('D2:D').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThan(0).setAllowInvalid(false)
    .setHelpText('Кількість, шт').build());

  sh.getRange('D2:D').setNumberFormat('0').setHorizontalAlignment('center');
  sh.getRange('E2:F').setNumberFormat('#,##0').setFontColor(COLORS.muted);
  sh.getRange('G2:H').setNumberFormat('#,##0" ₴"');
  sh.getRange('A2:A').setFontFamily('Roboto Mono');

  [120, 260, 200, 70, 90, 90, 130, 110, 230].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.hideColumns(C.SKU_AUTO, 2);

  sh.setConditionalFormatRules([
    // 1) помилки у формулах і статусах
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('!')
      .setBackground(COLORS.errBg).setFontColor(COLORS.errText).setBold(true)
      .setRanges([sh.getRange('E2:I')]).build(),
    // 2) інгредієнт вище за перший букет
    rule_(sh, 'A2:I', '=AND($C2<>"",$J2="")', COLORS.errBg, COLORS.errText, false),
    // 3) рядок-«шапка» букета
    rule_(sh, 'A2:I', '=$A2<>""', COLORS.block, COLORS.blockText, true),
    // 4) інгредієнти кожного другого букета — легкий фон
    rule_(sh, 'A2:I', '=AND($A2="",$C2<>"",ISEVEN($K2))', COLORS.band, null, false),
  ]);

  protect_(sh.getRange('E1:G'), 'coco:comp-formulas');
  protect_(sh.getRange('J1:K'), 'coco:comp-helpers');
  protect_(sh.getRange('H2:I'), 'coco:comp-site');
}

function setupHelp_(sh) {
  const lines = [
    ['Як користуватись'],
    [''],
    ['ЗМІНИТИ ЦІНУ КВІТКИ'],
    ['1. Аркуш «Інгредієнти» → зміни ціну в колонці B.'],
    ['2. На аркуші «Склад» у колонці «Ціна букета» одразу видно нові ціни.'],
    ['3. Меню CoCo → «Оновити ціни на сайті». Сайт опублікується сам.'],
    [''],
    ['НОВИЙ БУКЕТ'],
    ['1. Створи товар у Webflow з SKU, що починається на BQ- (наприклад BQ-00120-M).'],
    ['2. Меню CoCo → «Підтягнути букети з сайту» — внизу «Складу» з\'явиться сірий рядок букета.'],
    ['3. Виділи цей рядок → меню CoCo → «Додати інгредієнт під виділеним рядком».'],
    ['4. Обери інгредієнт зі списку і введи кількість. Повтори для кожного інгредієнта.'],
    [''],
    ['ЯК ЧИТАТИ «СКЛАД»'],
    ['• Сірий жирний рядок з чорною лінією зверху — це букет (SKU + назва + ціна).'],
    ['• Рядки під ним без SKU — його інгредієнти, аж до наступного сірого рядка.'],
    ['• Варіанти (S / M / L) — окремі букети зі своїм SKU і своїм складом.'],
    ['• Червоне — помилка: немає ціни, кількості або інгредієнта в довіднику.'],
    ['• Букет без інгредієнтів не чіпається — на сайті лишається його поточна ціна.'],
    [''],
    ['ВАЗИ, ДИФУЗОРИ, СЕРТИФІКАТИ'],
    ['• Ціну змінюєш у Webflow і публікуєш сайт — ціна для оплати оновиться сама за хвилину.'],
    ['• Якщо треба вручну: меню CoCo → «Синхронізувати ціни інших товарів з Webflow».'],
    [''],
    ['НЕ МОЖНА'],
    ['• Перейменовувати інгредієнт, який уже є в букетах (старі рядки втратять ціну).'],
    ['• Сортувати аркуш «Склад» — інгредієнти «відірвуться» від своїх букетів.'],
    ['• Писати в сірі колонки (Ціна за шт, Сума, Ціна букета, На сайті, Статус) — вони рахуються самі.'],
  ];
  sh.clear();
  sh.getRange(1, 1, lines.length, 1).setValues(lines).setWrap(true).setVerticalAlignment('middle');
  sh.setColumnWidth(1, 720);
  sh.getRange('A1').setFontSize(16).setFontWeight('bold');
  lines.forEach((l, i) => {
    if (/^[A-ZА-ЯІЇЄҐ«»', ]{4,}$/.test(l[0])) sh.getRange(i + 1, 1).setFontWeight('bold').setFontColor(COLORS.head);
  });
}

// ================== Читання і перевірка даних ==================
function readData_() {
  const ss = SpreadsheetApp.getActive();
  const ingrSh = ss.getSheetByName(CFG.SHEET_INGR);
  const compSh = ss.getSheetByName(CFG.SHEET_COMP);
  if (!ingrSh || !compSh) throw new Error('Немає потрібних аркушів. Запусти «CoCo → Перебудувати оформлення».');

  const errors = [];
  const ingredients = {};
  const iLast = lastDataRow_(ingrSh, 2);
  if (iLast >= 2) {
    ingrSh.getRange(2, 1, iLast - 1, 2).getValues().forEach((r, i) => {
      const name = String(r[0]).trim();
      if (!name) return;
      const price = Number(r[1]);
      if (ingredients[name] !== undefined) errors.push(`Інгредієнти, рядок ${i + 2}: «${name}» повторюється`);
      // інгредієнт без ціни — помилка лише тоді, коли він є в складі якогось букета (див. нижче)
      ingredients[name] = price > 0 ? price : null;
    });
  }

  const bouquets = [];
  const bySku = {};
  let cur = null;
  const cLast = lastDataRow_(compSh, 4);
  const rows = cLast >= 2 ? compSh.getRange(2, 1, cLast - 1, 4).getValues() : [];
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const sku = String(r[0]).trim();
    const title = String(r[1]).trim();
    const ingr = String(r[2]).trim();
    const qtyRaw = r[3];

    if (sku) {
      if (bySku[sku]) errors.push(`Склад, рядок ${rowNo}: SKU ${sku} вже є вище (рядок ${bySku[sku].row})`);
      cur = { sku, title, row: rowNo, items: [] };
      bouquets.push(cur);
      if (!bySku[sku]) bySku[sku] = cur;
    }
    if (!ingr) {
      if (!sku && qtyRaw !== '') errors.push(`Склад, рядок ${rowNo}: є кількість, але не обрано інгредієнт`);
      return;
    }
    if (!cur) { errors.push(`Склад, рядок ${rowNo}: інгредієнт «${ingr}» стоїть вище за перший букет`); return; }

    const qty = Number(qtyRaw);
    if (ingredients[ingr] === undefined) errors.push(`${cur.sku}, рядок ${rowNo}: «${ingr}» немає на аркуші «Інгредієнти»`);
    else if (ingredients[ingr] === null) errors.push(`${cur.sku}, рядок ${rowNo}: «${ingr}» без ціни на аркуші «Інгредієнти»`);
    if (!(qty > 0) || !Number.isInteger(qty)) errors.push(`${cur.sku}, рядок ${rowNo}: кількість має бути цілим числом більше 0`);
    if (cur.items.some((it) => it.ingredient === ingr)) errors.push(`${cur.sku}, рядок ${rowNo}: «${ingr}» уже є в цьому букеті — об'єднай рядки`);
    cur.items.push({ ingredient: ingr, qty, row: rowNo });
  });

  return { ingredients, bouquets, errors, compSh };
}

function checkComposition() {
  const ui = SpreadsheetApp.getUi();
  const { bouquets, errors, compSh, ingredients } = readData_();
  applyBlockBorders_(compSh);
  const noPrice = Object.keys(ingredients).filter((n) => ingredients[n] === null);
  if (errors.length) {
    ui.alert(`❗ Знайдено помилок: ${errors.length}`, listText_(errors), ui.ButtonSet.OK);
    return;
  }
  const empty = bouquets.filter((b) => !b.items.length).length;
  ui.alert('✅ Помилок немає',
    `Букетів (SKU): ${bouquets.length}\n` +
    `Зі складом: ${bouquets.length - empty}\n` +
    `Без складу (ціна на сайті не зміниться): ${empty}` +
    (noPrice.length ? `\n\nІнгредієнти без ціни (поки не використовуються): ${noPrice.join(', ')}` : ''),
    ui.ButtonSet.OK);
}

// ================== Редагування ==================
function insertIngredientRow() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== CFG.SHEET_COMP) { ui.alert('Перейди на аркуш «Склад» і виділи рядок букета або його інгредієнт.'); return; }
  const r = sh.getActiveRange().getRow();
  if (r < 2) { ui.alert('Виділи рядок букета або будь-який його інгредієнт.'); return; }
  sh.insertRowAfter(r);
  applyBlockBorders_(sh); // новий рядок успадковує лінію «шапки» — прибираємо
  sh.getRange(r + 1, C.INGR).activate();
}

// Лінія зверху над кожним рядком-«шапкою» букета
function applyBlockBorders_(sh) {
  const last = lastDataRow_(sh, 4);
  if (last < 2) return;
  sh.getRange(2, 1, last - 1, LAST_VISIBLE).setBorder(false, false, false, false, false, false);
  const a1 = [];
  sh.getRange(2, C.SKU, last - 1, 1).getValues().forEach((r, i) => {
    if (String(r[0]).trim()) a1.push(`A${i + 2}:I${i + 2}`);
  });
  if (a1.length) {
    sh.getRangeList(a1).setBorder(true, null, null, null, null, null, COLORS.border, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  }
}

// ================== Зв'язок із бекендом ==================
// Контракт (буде реалізовано на бекенді, заголовок x-pricing-key):
//   GET  /admin/pricing/products   → { ok, items: [{ sku, title, price }] }
//   POST /admin/pricing/recalc     { ingredients:[{name,price}], bouquets:[{sku,items:[{ingredient,qty}]}] }
//                                  → { ok, jobId }   (409, якщо оновлення вже йде)
//   POST /admin/pricing/sync       → { ok, total, changed: [sku] }
//   GET  /admin/pricing/jobs/:id   → { ok, state: 'running'|'done'|'failed', done, total,
//                                      results: [{ sku, price, status: 'updated'|'unchanged'|'error', message }],
//                                      published, publishError, error }

function configureConnection() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const url = ui.prompt('Адреса бекенду',
    `Зараз: ${props.getProperty('BACKEND_URL') || 'не задано'}\nНаприклад: https://coco-floral.fly.dev`,
    ui.ButtonSet.OK_CANCEL);
  if (url.getSelectedButton() !== ui.Button.OK) return;
  const key = ui.prompt('Ключ доступу',
    'Значення PRICING_KEY із секретів Fly.\nЗалиш порожнім, щоб не змінювати.',
    ui.ButtonSet.OK_CANCEL);
  if (key.getSelectedButton() !== ui.Button.OK) return;

  const u = url.getResponseText().trim().replace(/\/+$/, '');
  const k = key.getResponseText().trim();
  if (u) props.setProperty('BACKEND_URL', u);
  if (k) props.setProperty('PRICING_KEY', k);
  ui.alert('Збережено');
}

function api_(method, path, body) {
  const props = PropertiesService.getScriptProperties();
  const base = props.getProperty('BACKEND_URL');
  const key = props.getProperty('PRICING_KEY');
  if (!base || !key) throw new Error('Підключення не налаштоване: меню CoCo → «Налаштування підключення».');

  const options = { method, muteHttpExceptions: true, headers: { 'x-pricing-key': key } };
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }

  const res = UrlFetchApp.fetch(base + path, options);
  let json = {};
  try { json = JSON.parse(res.getContentText()); } catch (e) { /* не JSON */ }
  if (res.getResponseCode() >= 300 || json.ok === false) {
    throw new Error(json.error || `Сервер відповів HTTP ${res.getResponseCode()}`);
  }
  return json;
}

function pullBouquets() {
  const ui = SpreadsheetApp.getUi();
  try {
    const { items } = api_('get', '/admin/pricing/products');
    const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_COMP);
    const site = (items || []).filter((p) => String(p.sku || '').startsWith(CFG.SKU_PREFIX));

    // оновлюємо назви тих, що вже є
    const last = lastDataRow_(sh, 4);
    const existing = {};
    if (last >= 2) {
      const range = sh.getRange(2, 1, last - 1, 2);
      const vals = range.getValues();
      const titles = {};
      site.forEach((p) => { titles[p.sku] = p.title; });
      vals.forEach((r, i) => {
        const sku = String(r[0]).trim();
        if (!sku) return;
        existing[sku] = i + 2;
        if (titles[sku]) r[1] = titles[sku];
      });
      range.setValues(vals);
    }

    // нові букети — в кінець, шапкою без інгредієнтів
    const fresh = site.filter((p) => !existing[p.sku]).sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
    if (fresh.length) {
      const start = Math.max(last, 1) + 1;
      ensureRows_(sh, start + fresh.length - 1);
      sh.getRange(start, 1, fresh.length, 4).setValues(fresh.map((p) => [p.sku, p.title || '', '', '']));
    }
    applyBlockBorders_(sh);
    ui.alert('Готово', `Букетів на сайті: ${site.length}\nДодано нових: ${fresh.length}`, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('❗ Не вдалося', String(err.message || err), ui.ButtonSet.OK);
  }
}

// Вази, дифузори та інші товари: ціни для оплати беруться з Webflow.
// Зазвичай це відбувається саме після публікації сайту (вебхук), кнопка — на випадок, якщо треба вручну.
function syncPrices() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = api_('post', '/admin/pricing/sync', {});
    const list = (r.changed || []).slice(0, 25).join(', ');
    ui.alert('Готово',
      `Товарів у Webflow: ${r.total}\nЦін для оплати оновлено: ${(r.changed || []).length}` + (list ? `\n\n${list}` : ''),
      ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('❗ Не вдалося', String(err.message || err), ui.ButtonSet.OK);
  }
}

function updatePrices() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const data = readData_();

  if (data.errors.length) {
    ui.alert(`❗ Спершу виправ помилки (${data.errors.length})`, listText_(data.errors), ui.ButtonSet.OK);
    return;
  }
  const withItems = data.bouquets.filter((b) => b.items.length);
  if (!withItems.length) { ui.alert('Немає жодного букета зі складом.'); return; }

  const answer = ui.alert('Оновити ціни на сайті?',
    `Буде перераховано SKU: ${withItems.length}.\nЗмінені ціни запишуться у Webflow, після цього сайт опублікується.`,
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  // надсилаємо лише інгредієнти, що є в складі букетів
  const used = {};
  withItems.forEach((b) => b.items.forEach((it) => { used[it.ingredient] = true; }));
  const payload = {
    ingredients: Object.keys(used).map((name) => ({ name, price: data.ingredients[name] })),
    bouquets: withItems.map((b) => ({ sku: b.sku, items: b.items.map((it) => ({ ingredient: it.ingredient, qty: it.qty })) })),
  };

  try {
    const { jobId } = api_('post', '/admin/pricing/recalc', payload);
    const t0 = Date.now();
    let job;
    for (;;) {
      Utilities.sleep(CFG.POLL_SECONDS * 1000);
      job = api_('get', `/admin/pricing/jobs/${encodeURIComponent(jobId)}`);
      if (job.state !== 'running') break;
      ss.toast(`Оновлено ${job.done || 0} з ${job.total || '…'}`, 'CoCo', 5);
      if ((Date.now() - t0) / 1000 > CFG.POLL_MAX_SECONDS) {
        ui.alert('Оновлення ще триває на сервері. Натисни «Оновити ціни» ще раз за кілька хвилин — вже оновлені ціни не змінюватимуться повторно.');
        return;
      }
    }
    if (job.state === 'failed') throw new Error(job.error || 'Оновлення не вдалося');

    const results = job.results || [];
    writeResults_(data, results);
    SpreadsheetApp.flush(); // інакше статуси з'являться лише після закриття вікна
    const n = (s) => results.filter((r) => r.status === s).length;
    ui.alert('Готово',
      `Оновлено: ${n('updated')}\nБез змін: ${n('unchanged')}\nПомилок: ${n('error')}\n` +
      (n('updated') === 0 ? 'Цін не змінено — публікація не потрібна' :
        job.published ? 'Сайт опубліковано ✅' : `Сайт НЕ опубліковано ❗ ${job.publishError || ''}`),
      ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('❗ Не вдалося', String(err.message || err), ui.ButtonSet.OK);
  }
}

function writeResults_(data, results) {
  const sh = data.compSh;
  const bySku = {};
  results.forEach((r) => { bySku[r.sku] = r; });
  const last = lastDataRow_(sh, 4);
  if (last < 2) return;
  const range = sh.getRange(2, C.SITE, last - 1, 2);
  const vals = range.getValues();
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM HH:mm');
  data.bouquets.forEach((b) => {
    const r = bySku[b.sku];
    if (!r) return;
    const i = b.row - 2;
    if (r.price != null) vals[i][0] = r.price;
    vals[i][1] =
      r.status === 'error' ? `! ${r.message || 'помилка'} · ${now}` :
      r.status === 'updated' ? `✅ оновлено · ${now}` :
      `✔ без змін · ${now}`;
  });
  range.setValues(vals);
}

// ================== Допоміжне ==================
// setFormula залежить від локалі таблиці: в українській аргументи розділяються «;», в англійській «,».
// Формули в коді написані з комами; тут визначаємо, що приймає саме ця таблиця.
let SEP_ = ',';
function detectSeparator_(sh) {
  const cell = sh.getRange(1, sh.getMaxColumns());
  cell.setFormula('=IF(TRUE,1,2)');
  SpreadsheetApp.flush();
  SEP_ = cell.getValue() === 1 ? ',' : ';';
  cell.clearContent();
}
// у наших формулах коми є лише між аргументами (у текстах ком немає), тому проста заміна безпечна
function f_(formula) {
  return SEP_ === ',' ? formula : formula.replace(/,/g, SEP_);
}

// Останній рядок з даними в перших `cols` колонках (getLastRow бачить і порожні рядки ARRAYFORMULA)
function lastDataRow_(sh, cols) {
  const max = sh.getMaxRows();
  if (max < 2) return 1;
  const vals = sh.getRange(1, 1, max, cols).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i].some((v) => v !== '' && v !== null)) return i + 1;
  }
  return 0;
}

function ensureRows_(sh, needRow) {
  const max = sh.getMaxRows();
  if (needRow > max) sh.insertRowsAfter(max, needRow - max + 50);
}

function styleHeader_(range) {
  range.setBackground(COLORS.head).setFontColor(COLORS.headText).setFontWeight('bold').setVerticalAlignment('middle');
}

function rule_(sh, a1, formula, bg, color, bold) {
  const b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f_(formula)).setRanges([sh.getRange(a1)]);
  if (bg) b.setBackground(bg);
  if (color) b.setFontColor(color);
  if (bold) b.setBold(true);
  return b.build();
}

function protect_(range, desc) {
  const sh = range.getSheet();
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE)
    .filter((p) => p.getDescription() === desc)
    .forEach((p) => p.remove());
  range.protect().setDescription(desc).setWarningOnly(true);
}

function listText_(arr) {
  const max = 25;
  return arr.slice(0, max).join('\n') + (arr.length > max ? `\n…і ще ${arr.length - max}` : '');
}
