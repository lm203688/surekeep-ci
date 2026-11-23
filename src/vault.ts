/**
 * 生活管理保险库 —— 领域逻辑内核（第二层）：保险 + 重要证件 + 统一导出
 *
 * 与 warranty.ts（质保/退换/索赔）共同构成第二款 D2 的差异化确定性逻辑。
 * 本文件零依赖、零平台 API，可本机 `node --experimental-strip-types` 跑单测。
 * 复用 warranty.ts 的日期工具（addDuration / daysBetween / coverageStatus）与 csvCell。
 *
 * 与首款 Redoubt（通用加密箱）的边界：本内核解决"买完/投保后，
 * 保单何时续费、证件何时过期、索赔/报税要带哪些凭证"的具体刚需闭环，
 * 不是另一个装任意文件的箱子。
 */

import {
  addDuration,
  daysBetween,
  coverageStatus,
  csvCell,
  viewCoverage,
  type DurationUnit,
  type WarrantyCoverage,
  type PurchaseItem,
  type CoverageView,
} from './warranty.ts';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type InsuranceCategory =
  | 'auto' | 'home' | 'health' | 'life' | 'phone' | 'travel' | 'other';

export type PremiumCycle = 'monthly' | 'quarterly' | 'yearly';

export interface InsurancePolicy {
  id: string;
  category: InsuranceCategory;
  provider: string;
  policyNumber: string;
  holder?: string;
  /** 保单起始日；若未给 expiryDate，则用它 + duration 推算到期 */
  startDate?: string;
  durationValue?: number;
  durationUnit?: DurationUnit;
  /** 保单到期日（ISO）；优先于 start + duration */
  expiryDate?: string;
  /** 下次保费到期日（ISO），用于续费提醒 */
  premiumDueDate?: string;
  premiumCycle?: PremiumCycle;
  premiumAmountCents?: number | null;
  currency?: string;
  /** 指向本机保单照片/文件的引用（仅字符串） */
  proofRef?: string;
  note?: string;
}

export type DocType =
  | 'passport' | 'id' | 'driver-license' | 'residence-permit'
  | 'certificate' | 'contract' | 'other';

export interface ImportantDoc {
  id: string;
  docType: DocType;
  issuer?: string;
  docNumber?: string;
  holder?: string;
  issueDate?: string;
  /** 有效期截止（ISO）；无则视为长期有效 */
  expiryDate?: string;
  proofRef?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// 视图（带到期日 / 剩余天数 / 状态）
// ---------------------------------------------------------------------------

export interface InsuranceView {
  policy: InsurancePolicy;
  expiryDate: string | null;
  daysToExpiry: number | null;
  daysToPremiumDue: number | null;
  status: 'active' | 'expiring' | 'expired';
}

export interface DocView {
  doc: ImportantDoc;
  daysToExpiry: number | null;
  status: 'active' | 'expiring' | 'expired' | 'no-expiry';
}

// ---------------------------------------------------------------------------
// 日期有效性（复用 addDuration 的 null 语义判断）
// ---------------------------------------------------------------------------

function isValidDate(s?: string): boolean {
  if (!s) return false;
  return addDuration(s, 0, 'day') !== null;
}

// ---------------------------------------------------------------------------
// 保险逻辑
// ---------------------------------------------------------------------------

/** 解析保单到期日：expiryDate 优先；否则由 start + duration 推算。非法返回 null。 */
export function resolveInsuranceExpiry(p: InsurancePolicy): string | null {
  if (p.expiryDate) return isValidDate(p.expiryDate) ? p.expiryDate : null;
  if (p.startDate && p.durationValue != null && p.durationUnit) {
    return addDuration(p.startDate, p.durationValue, p.durationUnit);
  }
  return null;
}

export function viewInsurance(
  p: InsurancePolicy,
  refDate: string,
  warnDays = 30,
): InsuranceView {
  const expiry = resolveInsuranceExpiry(p);
  const daysToExpiry = expiry ? daysBetween(expiry, refDate) : null;
  const status = expiry ? coverageStatus(expiry, refDate, warnDays) : 'expired';
  const daysToPremiumDue =
    p.premiumDueDate && isValidDate(p.premiumDueDate)
      ? daysBetween(p.premiumDueDate, refDate)
      : null;
  return { policy: p, expiryDate: expiry, daysToExpiry, daysToPremiumDue, status };
}

// ---------------------------------------------------------------------------
// 证件逻辑
// ---------------------------------------------------------------------------

export function viewDoc(
  d: ImportantDoc,
  refDate: string,
  warnDays = 30,
): DocView {
  if (!d.expiryDate || !isValidDate(d.expiryDate)) {
    return { doc: d, daysToExpiry: null, status: 'no-expiry' };
  }
  const days = daysBetween(d.expiryDate, refDate);
  let status: DocView['status'] = 'active';
  if (Number.isNaN(days)) status = 'no-expiry';
  else if (days < 0) status = 'expired';
  else if (days <= warnDays) status = 'expiring';
  return { doc: d, daysToExpiry: Number.isNaN(days) ? null : days, status };
}

// ---------------------------------------------------------------------------
// 校验（UI 落库前拦截非法数据）
// ---------------------------------------------------------------------------

export function validateInsurance(p: InsurancePolicy): string[] {
  const errs: string[] = [];
  if (!p.id) errs.push('MISSING_ID');
  if (!p.category) errs.push('MISSING_CATEGORY');
  if (!p.provider || !p.provider.trim()) errs.push('MISSING_PROVIDER');
  if (!p.policyNumber || !p.policyNumber.trim()) errs.push('MISSING_POLICY_NUMBER');
  if (!resolveInsuranceExpiry(p)) errs.push('MISSING_OR_INVALID_EXPIRY');
  if (p.premiumDueDate && !isValidDate(p.premiumDueDate)) errs.push('INVALID_PREMIUM_DUE_DATE');
  return errs;
}

export function validateDoc(d: ImportantDoc): string[] {
  const errs: string[] = [];
  if (!d.id) errs.push('MISSING_ID');
  if (!d.docType) errs.push('MISSING_DOC_TYPE');
  if (d.expiryDate && !isValidDate(d.expiryDate)) errs.push('INVALID_EXPIRY_DATE');
  return errs;
}

// ---------------------------------------------------------------------------
// 统一导出（质保 + 保险 + 证件 → 理赔/报税就绪清单，含公式注入防护）
// ---------------------------------------------------------------------------

export type VaultRowKind = 'warranty' | 'insurance' | 'doc';

export interface VaultRow {
  kind: VaultRowKind;
  name: string;
  identifier: string; // 物品名 / 保单号 / 证件号
  category: string;
  expiry: string | null;
  daysLeft: number | null;
  status: string;
  proofRef: string;
}

export interface VaultExport {
  generatedAt: string;
  rows: VaultRow[];
}

/**
 * 把四类记录（物品仅用于给质保行补名字）投影成统一行，按"剩余天数"升序（最紧急在前，无期限置底）。
 * refDate 模拟"今天"，保证纯函数、可测。
 */
export function buildVaultExport(
  items: PurchaseItem[],
  warranties: WarrantyCoverage[],
  insurances: InsurancePolicy[],
  docs: ImportantDoc[],
  refDate: string,
  warnDays = 30,
): VaultExport {
  const nameById = new Map(items.map((it) => [it.id, it.name]));
  const rows: VaultRow[] = [];

  for (const w of warranties) {
    const v: CoverageView = viewCoverage(w, refDate, warnDays);
    rows.push({
      kind: 'warranty',
      name: nameById.get(w.itemId) ?? w.itemId,
      identifier: w.itemId,
      category: w.provider,
      expiry: v.expiry,
      daysLeft: v.daysLeft,
      status: v.status,
      proofRef: w.proofRef ?? '',
    });
  }

  for (const p of insurances) {
    const v = viewInsurance(p, refDate, warnDays);
    rows.push({
      kind: 'insurance',
      name: `${p.category}@${p.provider}`,
      identifier: p.policyNumber,
      category: p.category,
      expiry: v.expiryDate,
      daysLeft: v.daysToExpiry,
      status: v.status,
      proofRef: p.proofRef ?? '',
    });
  }

  for (const d of docs) {
    const v = viewDoc(d, refDate, warnDays);
    rows.push({
      kind: 'doc',
      name: d.docType,
      identifier: d.docNumber ?? '',
      category: d.issuer ?? '',
      expiry: d.expiryDate ?? null,
      daysLeft: v.daysToExpiry,
      status: v.status,
      proofRef: d.proofRef ?? '',
    });
  }

  const rank = (r: VaultRow) => {
    if (r.daysLeft == null) return Number.MAX_SAFE_INTEGER; // 无期限置底
    if (r.daysLeft < 0) return r.daysLeft + Number.MAX_SAFE_INTEGER / 2; // 已过期排末尾但先于无期限
    return r.daysLeft;
  };
  rows.sort((a, b) => rank(a) - rank(b));

  return { generatedAt: refDate, rows };
}

const EXPORT_HEADERS = [
  'Kind', 'Name', 'Identifier', 'Category',
  'Expiry', 'DaysLeft', 'Status', 'ProofRef',
] as const;

export function vaultExportToCsv(exp: VaultExport): string {
  const lines = exp.rows.map((r) =>
    [r.kind, r.name, r.identifier, r.category, r.expiry, r.daysLeft ?? '', r.status, r.proofRef]
      .map(csvCell)
      .join(','),
  );
  return '﻿' + EXPORT_HEADERS.join(',') + '\r\n' + lines.join('\r\n') + '\r\n';
}

export function vaultExportToJson(exp: VaultExport): string {
  return JSON.stringify(exp, null, 2);
}
