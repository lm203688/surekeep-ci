/**
 * 质保 & 凭证保险库 —— 领域逻辑内核（纯 TypeScript，零依赖、零平台 API）
 *
 * 设计约束（与首款 Redoubt 的通用加密箱划清边界）：
 *  - 本文件只装「质保 / 退换 / 索赔」这一条业务链路的确定性逻辑，
 *    不含任何 UI、存储、OCR、网络代码，故可本机 `node --experimental-strip-types` 跑单测。
 *  - 所有"今天"均通过参数 refDate 显式传入，函数保持纯函数、可确定性测试。
 *  - 所有日期按 UTC 午夜计算天数差，规避时区 / 夏令时导致的差一天问题。
 *
 * 这是第二款的差异化内核：首款 Redoubt 是"任意文件的加密箱"，
 * 本内核解决的是"买完东西后，什么时候过保、退换期还剩几天、索赔要带什么"的具体刚需。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一次购买（凭证的最小单元）。金额用最小货币单位（分）避免浮点误差。 */
export interface PurchaseItem {
  id: string;
  name: string;
  merchant: string;
  /** ISO 8601 YYYY-MM-DD；购买日也是质保起始日 */
  purchaseDate: string;
  amountCents?: number | null;
  currency?: string;
  category?: string;
  /** 指向本机收据图片 / 凭证文件的引用（仅字符串，绝不在此持有二进制） */
  receiptRef?: string;
  note?: string;
}

export type WarrantyProvider =
  | 'manufacturer' // 厂家质保
  | 'store'        // 店铺延保
  | 'extended'     // 第三方延长保
  | 'credit-card'  // 信用卡附赠延保
  | 'other';

export type DurationUnit = 'day' | 'month' | 'year';

export interface WarrantyCoverage {
  id: string;
  itemId: string;
  provider: WarrantyProvider;
  label?: string;
  /** 质保起始日（通常等于购买日） */
  startDate: string;
  durationValue: number;
  durationUnit: DurationUnit;
  /** 凭证引用（保单号 / 照片），仅字符串 */
  proofRef?: string;
  note?: string;
}

export type CoverageStatus = 'active' | 'expiring' | 'expired';

export interface CoverageView {
  coverage: WarrantyCoverage;
  expiry: string | null;
  daysLeft: number | null;
  status: CoverageStatus;
}

export interface ClaimPack {
  generatedAt: string;
  item: PurchaseItem & { daysSincePurchase: number };
  returnWindow: {
    policyDays: number | null;
    deadline: string | null;
    within: boolean | null;
    daysLeft: number | null;
  };
  coverages: CoverageView[];
  /** 当前最优先（最晚到期且未过期）的覆盖；全部过期则为 null */
  activeCoverage: CoverageView | null;
}

// ---------------------------------------------------------------------------
// 日期工具（全部 UTC，规避时区）
// ---------------------------------------------------------------------------

function parseYMD(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isValidDate(s: string): boolean {
  return parseYMD(s) !== null;
}

/** 天数差 = target - ref（整天数，可为负）。两端均按 UTC 午夜。 */
export function daysBetween(target: string, ref: string): number {
  const a = parseYMD(target), b = parseYMD(ref);
  if (!a || !b) return NaN;
  const ta = Date.UTC(a.y, a.m - 1, a.d);
  const tb = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((ta - tb) / 86400000);
}

/**
 * 给定起始日，按 天/月/年 加一个时长，返回到期日（ISO）。
 * 处理月末溢出（1 月 31 日 + 1 月 → 2 月最后一天）与闰年（2024-02-29 + 1 年 → 2025-02-28）。
 * 非法输入返回 null。
 */
export function addDuration(date: string, value: number, unit: DurationUnit): string | null {
  const p = parseYMD(date);
  if (!p || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  if (unit === 'day') {
    const t = Date.UTC(p.y, p.m - 1, p.d) + value * 86400000;
    const d = new Date(t);
    return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  let y = p.y, mo = p.m, d = p.d;
  if (unit === 'month') {
    mo += value;
    while (mo > 12) { mo -= 12; y += 1; }
    while (mo < 1) { mo += 12; y -= 1; }
  } else if (unit === 'year') {
    y += value;
  }
  // 月末溢出：目标月没有原日期时，回退到月末最后一天
  const dim = daysInMonth(y, mo);
  if (d > dim) d = dim;
  return fmt(y, mo, d);
}

// ---------------------------------------------------------------------------
// 质保 / 退换核心逻辑
// ---------------------------------------------------------------------------

/** 单条质保的到期日；startDate 非法或时长非法时返回 null。 */
export function warrantyExpiry(w: WarrantyCoverage): string | null {
  return addDuration(w.startDate, w.durationValue, w.durationUnit);
}

/** refDate 距到期日的剩余天数（可为负）。 */
export function daysRemaining(expiry: string, refDate: string): number {
  return daysBetween(expiry, refDate);
}

/**
 * 覆盖状态：
 *  - expired  ：已过期（剩余 < 0）
 *  - expiring ：临近过期（0 ≤ 剩余 ≤ warnDays）
 *  - active   ：充足
 */
export function coverageStatus(expiry: string, refDate: string, warnDays = 30): CoverageStatus {
  const d = daysRemaining(expiry, refDate);
  if (Number.isNaN(d)) return 'expired';
  if (d < 0) return 'expired';
  if (d <= warnDays) return 'expiring';
  return 'active';
}

/** 退换截止日 = 购买日 + 退换政策天数。 */
export function returnDeadline(purchaseDate: string, returnPolicyDays: number): string | null {
  if (returnPolicyDays < 0) return null;
  return addDuration(purchaseDate, returnPolicyDays, 'day');
}

/** 购买日 ~ refDate 是否仍在退换窗口内。 */
export function isWithinReturnWindow(
  purchaseDate: string,
  refDate: string,
  returnPolicyDays: number,
): boolean | null {
  const dl = returnDeadline(purchaseDate, returnPolicyDays);
  if (!dl) return null;
  return daysRemaining(dl, refDate) >= 0;
}

/** 把一条质保投影成带到期日 / 剩余天数 / 状态的视图。 */
export function viewCoverage(w: WarrantyCoverage, refDate: string, warnDays = 30): CoverageView {
  const expiry = warrantyExpiry(w);
  const daysLeft = expiry ? daysRemaining(expiry, refDate) : null;
  const status = expiry ? coverageStatus(expiry, refDate, warnDays) : 'expired';
  return { coverage: w, expiry, daysLeft, status };
}

/**
 * 当前最优覆盖：在所有未过期的质保里，挑"剩余天数最多"（即最晚到期）的那条。
 * 全部过期或列表为空时返回 null。
 */
export function bestCoverage(
  warranties: WarrantyCoverage[],
  refDate: string,
  warnDays = 30,
): CoverageView | null {
  let best: CoverageView | null = null;
  for (const w of warranties) {
    const v = viewCoverage(w, refDate, warnDays);
    if (v.status === 'expired') continue;
    if (!best || (v.daysLeft ?? -1) > (best.daysLeft ?? -1)) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 校验（供 UI 在落库前拦截非法数据）
// ---------------------------------------------------------------------------

export function validateWarranty(w: WarrantyCoverage): string[] {
  const errs: string[] = [];
  if (!w.id) errs.push('MISSING_ID');
  if (!w.itemId) errs.push('MISSING_ITEM_ID');
  if (!w.provider) errs.push('MISSING_PROVIDER');
  if (!isValidDate(w.startDate)) errs.push('INVALID_START_DATE');
  if (!Number.isFinite(w.durationValue) || w.durationValue <= 0) errs.push('INVALID_DURATION_VALUE');
  if (!['day', 'month', 'year'].includes(w.durationUnit)) errs.push('INVALID_DURATION_UNIT');
  return errs;
}

export function validateItem(it: PurchaseItem): string[] {
  const errs: string[] = [];
  if (!it.id) errs.push('MISSING_ID');
  if (!it.name || !it.name.trim()) errs.push('MISSING_NAME');
  if (!isValidDate(it.purchaseDate)) errs.push('INVALID_PURCHASE_DATE');
  if ('amountCents' in it && it.amountCents != null && !Number.isFinite(it.amountCents)) {
    errs.push('INVALID_AMOUNT');
  }
  return errs;
}

// ---------------------------------------------------------------------------
// 索赔就绪导出（结构化，供 UI 拼 PDF / CSV；含公式注入防护）
// ---------------------------------------------------------------------------

/**
 * 把一条购买 + 其全部质保，组装成"索赔就绪"的结构化包。
 * refDate 模拟"今天"，保证纯函数、可测。
 */
export function buildClaimPack(
  item: PurchaseItem,
  warranties: WarrantyCoverage[],
  refDate: string,
  returnPolicyDays: number | null = null,
  warnDays = 30,
): ClaimPack {
  const daysSincePurchase = daysBetween(refDate, item.purchaseDate);
  const dl = returnPolicyDays != null ? returnDeadline(item.purchaseDate, returnPolicyDays) : null;
  const within = dl ? daysRemaining(dl, refDate) >= 0 : null;
  const daysLeft = dl ? daysRemaining(dl, refDate) : null;

  const coverages = warranties
    .filter((w) => w.itemId === item.id)
    .map((w) => viewCoverage(w, refDate, warnDays));

  return {
    generatedAt: refDate,
    item: { ...item, daysSincePurchase },
    returnWindow: { policyDays: returnPolicyDays, deadline: dl, within, daysLeft },
    coverages,
    activeCoverage: bestCoverage(
      warranties.filter((w) => w.itemId === item.id),
      refDate,
      warnDays,
    ),
  };
}

/** 防 Excel/Sheets 把 = + - @ 开头单元格当公式执行 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const PACK_HEADERS = [
  'Item', 'Merchant', 'PurchaseDate', 'DaysSincePurchase',
  'ReturnPolicyDays', 'ReturnDeadline', 'WithinReturn',
  'ActiveProvider', 'ActiveExpiry', 'ActiveDaysLeft', 'ActiveStatus',
] as const;

/** 索赔包的扁平 CSV（一行 = 一个物品 + 其最优覆盖） */
export function claimPackToCsv(pack: ClaimPack): string {
  const ac = pack.activeCoverage;
  const row = [
    pack.item.name,
    pack.item.merchant,
    pack.item.purchaseDate,
    pack.item.daysSincePurchase,
    pack.returnWindow.policyDays ?? '',
    pack.returnWindow.deadline ?? '',
    pack.returnWindow.within ?? '',
    ac ? ac.coverage.provider : '',
    ac ? ac.expiry : '',
    ac ? ac.daysLeft ?? '' : '',
    ac ? ac.status : '',
  ].map(csvCell).join(',');
  return '﻿' + PACK_HEADERS.join(',') + '\r\n' + row + '\r\n';
}

export function claimPackToJson(pack: ClaimPack): string {
  return JSON.stringify(pack, null, 2);
}
