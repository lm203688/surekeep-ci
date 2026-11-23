/**
 * SureKeep 收据解析层（原 SlipBox 遗留，保留为 D2 凭证输入层；纯 TypeScript，零依赖、零平台 API）
 *
 * 设计约束：本文件必须保持「自包含、无 import」，这样：
 *  1. React Native / Metro 可直接以无扩展名方式导入；
 *  2. 本机 Windows 可用 `node --experimental-strip-types` 直接跑单元测试，
 *     无需 Mac / Xcode / 模拟器。
 *
 * 领域逻辑是产品的真实壁垒：OCR 给出的是一堆无序文本行，
 * 能否稳定还原 merchant / date / total / tax，决定用户留不留。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type Currency = 'USD' | 'EUR' | 'GBP' | 'CNY' | 'JPY' | 'UNKNOWN';

export type ExpenseCategory =
  | 'groceries'
  | 'dining'
  | 'transport'
  | 'office'
  | 'travel'
  | 'health'
  | 'utilities'
  | 'other';

export interface ReceiptLine {
  text: string;
  /** OCR 置信度 0–1；未知时省略 */
  confidence?: number;
}

export interface ParsedReceipt {
  merchant: string;
  /** ISO 8601 YYYY-MM-DD；无法解析为 null */
  date: string | null;
  /** 最小货币单位（分），避免浮点误差 */
  totalCents: number | null;
  taxCents: number | null;
  currency: Currency;
  category: ExpenseCategory;
  lineItems: string[];
  /** 0–1，供 UI 提示「需要人工确认」 */
  confidence: number;
  warnings: string[];
}

export interface Receipt extends ParsedReceipt {
  id: string;
  /** 本地图片 URI，绝不出设备 */
  imageUri?: string;
  note: string;
  createdAt: string;
  /** 用户已确认过解析结果 */
  reviewed: boolean;
}

export interface MonthlySummary {
  month: string;
  totalCents: number;
  count: number;
  byCategory: Partial<Record<ExpenseCategory, number>>;
}

// ---------------------------------------------------------------------------
// 金额解析
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Array<[RegExp, Currency]> = [
  [/\$|USD\b/i, 'USD'],
  [/€|EUR\b/i, 'EUR'],
  [/£|GBP\b/i, 'GBP'],
  [/¥|CNY\b|RMB\b/i, 'CNY'],
  [/JPY\b|円/i, 'JPY'],
];

/** 从任意文本里抽出所有金额，返回「分」。支持 1,234.56 / 1.234,56 / 12.90 / 12,- */
export function extractAmounts(text: string): number[] {
  if (!text) return [];
  const out: number[] = [];
  // 先匹配带千分位与小数的形式
  const rich = /(?<![\d.,])([+-]?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})|[+-]?\d+[.,]\d{2})(?![\d])/g;
  // 再匹配整数金额（仅在带货币符号时才纳入，避免把数量/件数当金额）
  const plain = /(?:[$€£¥])\s*(\d{1,6})(?![\d.,])/g;

  for (const m of text.matchAll(rich)) {
    out.push(toCents(m[1]));
  }
  for (const m of text.matchAll(plain)) {
    out.push(parseInt(m[1], 10) * 100);
  }
  return out.filter(Number.isFinite);
}

/** 把 "1,234.56" / "1.234,56" / "12,90" 统一换算为分 */
export function toCents(raw: string): number {
  const s = raw.trim().replace(/^[+]/, '');
  const negative = s.startsWith('-');
  const clean = s.replace(/^[+-]/, '');
  const lastComma = clean.lastIndexOf(',');
  const lastDot = clean.lastIndexOf('.');
  let normalized: string;

  if (lastComma > lastDot) {
    // 逗号是小数分隔符（欧洲写法）或千分位
    const frac = clean.slice(lastComma + 1);
    if (frac.length === 2 && !clean.slice(0, lastComma).includes(',')) {
      normalized = clean.slice(0, lastComma).replace(/\./g, '') + '.' + frac;
    } else {
      normalized = clean.replace(/,/g, '');
    }
  } else if (lastDot > -1) {
    const frac = clean.slice(lastDot + 1);
    const head = clean.slice(0, lastDot);
    if (frac.length === 2) {
      normalized = head.replace(/[.,]/g, '') + '.' + frac;
    } else {
      normalized = clean.replace(/,/g, '');
    }
  } else {
    normalized = clean;
  }
  const value = Math.round(parseFloat(normalized) * 100);
  if (!Number.isFinite(value)) return NaN;
  return negative ? -value : value;
}

export function detectCurrency(text: string): Currency {
  for (const [re, code] of CURRENCY_SYMBOLS) {
    if (re.test(text)) return code;
  }
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// 日期解析
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 识别 YYYY-MM-DD、DD/MM/YYYY、MM/DD/YYYY、Nov 10 2026、10.11.2026 */
export function parseDate(text: string): string | null {
  if (!text) return null;
  const s = text.trim();

  let m = s.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = s.match(/\b(\d{1,2})([-/.])(\d{1,2})\2(20\d{2})\b/);
  if (m) {
    const a = +m[1], sep = m[2], b = +m[3], y = +m[4];
    // 歧义消解：
    //  - 首段 > 12 只可能是 DD/MM；
    //  - 点号 / 横线分隔是欧洲小票习惯（10.11.2026 = 11 月 10 日），优先 DD.MM；
    //  - 斜杠分隔按美式 MM/DD（美国小票主流）。
    if (a > 12 || sep === '.' || sep === '-') return iso(y, b, a);
    return iso(y, a, b);
  }

  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s*(20\d{2})\b/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return iso(+m[3], mon, +m[2]);
  }

  m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(20\d{2})\b/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return iso(+m[3], mon, +m[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 商户 / 分类
// ---------------------------------------------------------------------------

const NOISE = /^(receipt|invoice|bill|tax invoice|welcome|thank you|thanks|customer copy|merchant copy|store|cash|card|visa|mastercard|change|subtotal|total|amount|date|time|tel|phone|www\.|http|@|order|#|\d{1,2}[:.\/]\d{2})/i;

const CATEGORY_RULES: Array<[RegExp, ExpenseCategory]> = [
  [/\b(supermarket|grocery|grocer|market|walmart|tesco|carrefour|aldi|lidl|costco|whole foods|7-?eleven)\b/i, 'groceries'],
  [/\b(restaurant|cafe|coffee|starbucks|mcdonald|kfc|pizza|sushi|bar|bistro|bakery|diner)\b/i, 'dining'],
  [/\b(uber|lyft|taxi|metro|rail|train|bus|parking|fuel|gas station|shell|bp|toll|airline|airways)\b/i, 'transport'],
  [/\b(office|stationery|staples|printer|ink|software|subscription|aws|github|adobe)\b/i, 'office'],
  [/\b(hotel|airbnb|booking|hostel|resort|travel|airport)\b/i, 'travel'],
  [/\b(pharmacy|clinic|hospital|dentist|chemist|drugstore|cv[sx]|boots)\b/i, 'health'],
  [/\b(electric|water|gas bill|internet|telecom|utility|broadband)\b/i, 'utilities'],
];

/** 从 OCR 前几行猜商户名：跳过日期、金额、电话、地址、样板词 */
export function parseMerchant(lines: string[]): string {
  const candidates = lines
    .slice(0, 8)
    .map((l) => l.trim())
    .filter((l) => l.length >= 3 && l.length <= 60)
    .filter((l) => !NOISE.test(l))
    .filter((l) => !parseDate(l))
    .filter((l) => !/^\d[\d\s./:-]*$/.test(l))
    .filter((l) => !/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(l))
    .filter((l) => extractAmounts(l).length === 0)
    .filter((l) => !/^https?:\/\//i.test(l));
  return candidates[0] ?? '';
}

export function categorize(merchant: string, fullText: string): ExpenseCategory {
  const hay = `${merchant} ${fullText.slice(0, 400)}`;
  for (const [re, cat] of CATEGORY_RULES) {
    if (re.test(hay)) return cat;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// 主解析入口
// ---------------------------------------------------------------------------

const TOTAL_RE = /\b(grand\s*total|total\s*(due|amount)?|amount\s*due|balance\s*due|summe|gesamt|total\s*à\s*payer|to\s*pay|payable)\b/i;
const SUBTOTAL_RE = /\b(sub\s*total|subtotal|zwischensumme|net\s*amount)\b/i;
const TAX_RE = /\b(tax|vat|gst|mwst|tva|iva|sales\s*tax|meals\s*tax)\b/i;
const CHANGE_RE = /\b(change|cash\s*tendered|rückgeld)\b/i;

/**
 * 把 OCR 文本行还原成结构化收据。
 * 优先级：显式 TOTAL 行 > 全篇最大金额；始终排除 subtotal / tax / change 行。
 */
export function parseReceipt(input: string[] | string, currencyHint?: Currency): ParsedReceipt {
  const lines: string[] = (Array.isArray(input) ? input : input.split(/\r?\n/))
    .map((l) => l.trim())
    .filter(Boolean);
  const fullText = lines.join('\n');
  const warnings: string[] = [];
  const currency = currencyHint && currencyHint !== 'UNKNOWN' ? currencyHint : detectCurrency(fullText);

  // --- total -------------------------------------------------------------
  let totalCents: number | null = null;
  let explicitTotal = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TOTAL_RE.test(line) || SUBTOTAL_RE.test(line) || CHANGE_RE.test(line)) continue;
    const own = extractAmounts(line);
    if (own.length > 0) {
      totalCents = Math.max(...own);
      explicitTotal = true;
      break;
    }
    // 金额常在 TOTAL 的下一行
    if (i + 1 < lines.length) {
      const next = extractAmounts(lines[i + 1]);
      if (next.length === 1) {
        totalCents = next[0];
        explicitTotal = true;
        break;
      }
    }
  }
  if (totalCents === null) {
    const candidates = lines
      .filter((l) => !SUBTOTAL_RE.test(l) && !TAX_RE.test(l) && !CHANGE_RE.test(l))
      .flatMap(extractAmounts)
      .filter((v) => v > 0);
    if (candidates.length) {
      totalCents = Math.max(...candidates);
      warnings.push('NO_EXPLICIT_TOTAL');
    } else {
      warnings.push('NO_AMOUNT_FOUND');
    }
  }

  // --- tax ---------------------------------------------------------------
  let taxCents: number | null = null;
  for (const line of lines) {
    if (!TAX_RE.test(line) || SUBTOTAL_RE.test(line)) continue;
    const amounts = extractAmounts(line);
    if (amounts.length) {
      taxCents = Math.max(...amounts);
      break;
    }
  }

  // --- date / merchant / category ---------------------------------------
  let date: string | null = null;
  for (const line of lines.slice(0, 15)) {
    date = parseDate(line);
    if (date) break;
  }
  if (!date) warnings.push('NO_DATE');

  const merchant = parseMerchant(lines);
  if (!merchant) warnings.push('NO_MERCHANT');

  const lineItems = lines
    .filter((l) => extractAmounts(l).length > 0)
    .filter((l) => !TOTAL_RE.test(l) && !SUBTOTAL_RE.test(l) && !TAX_RE.test(l) && !CHANGE_RE.test(l))
    .slice(0, 40);

  // --- confidence --------------------------------------------------------
  let confidence = 0;
  if (explicitTotal) confidence += 0.45;
  else if (totalCents !== null) confidence += 0.2;
  if (date) confidence += 0.2;
  if (merchant) confidence += 0.2;
  if (currency !== 'UNKNOWN') confidence += 0.1;
  if (taxCents !== null) confidence += 0.05;
  confidence = Math.min(1, Math.round(confidence * 100) / 100);
  if (confidence < 0.6) warnings.push('LOW_CONFIDENCE');

  return {
    merchant,
    date,
    totalCents,
    taxCents,
    currency,
    category: categorize(merchant, fullText),
    lineItems,
    confidence,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export function summarize(receipts: Receipt[]): MonthlySummary[] {
  const map = new Map<string, MonthlySummary>();
  for (const r of receipts) {
    if (r.totalCents === null) continue;
    const month = (r.date ?? r.createdAt).slice(0, 7);
    let s = map.get(month);
    if (!s) {
      s = { month, totalCents: 0, count: 0, byCategory: {} };
      map.set(month, s);
    }
    s.totalCents += r.totalCents;
    s.count += 1;
    s.byCategory[r.category] = (s.byCategory[r.category] ?? 0) + r.totalCents;
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export function formatMoney(cents: number | null, currency: Currency = 'UNKNOWN'): string {
  if (cents === null) return '—';
  const symbols: Record<Currency, string> = {
    USD: '$', EUR: '€', GBP: '£', CNY: '¥', JPY: '¥', UNKNOWN: '',
  };
  const v = (cents / 100).toFixed(2);
  return `${symbols[currency]}${v}`;
}

// ---------------------------------------------------------------------------
// CSV 导出（含公式注入防护）
// ---------------------------------------------------------------------------

export const CSV_HEADERS = ['Date', 'Merchant', 'Category', 'Currency', 'Total', 'Tax', 'Note', 'Reviewed'] as const;

/** 防止 Excel/Sheets 把 = + - @ 开头的单元格当公式执行 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function receiptsToCsv(receipts: Receipt[]): string {
  const rows = [CSV_HEADERS.join(',')];
  const sorted = [...receipts].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  for (const r of sorted) {
    rows.push([
      r.date ?? '',
      r.merchant,
      r.category,
      r.currency,
      r.totalCents === null ? '' : (r.totalCents / 100).toFixed(2),
      r.taxCents === null ? '' : (r.taxCents / 100).toFixed(2),
      r.note,
      r.reviewed ? 'yes' : 'no',
    ].map(csvCell).join(','));
  }
  // BOM 让 Excel 正确识别 UTF-8
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}
