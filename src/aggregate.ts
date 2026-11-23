/**
 * SureKeep D2 —— 时间轴聚合层（纯 TypeScript，零依赖、零平台 API）
 *
 * 把三个内核（warranty / vault / domain）的数据，统一投影成首页最关心的
 * "什么快到期 / 什么已过期 / 什么还有效" 一条时间轴。
 *
 * 设计约束：
 *  - 所有"今天"通过 refDate 显式传入，输出确定、可本机测试。
 *  - 只做数据投影与排序，不碰 UI / 存储 / OCR / 网络。
 *  - v1 聚焦可行动项：退换窗口仅显示仍在窗口内或刚过 7 天内的条目。
 */
import {
  viewCoverage,
  coverageStatus,
  daysBetween,
  returnDeadline,
  type PurchaseItem,
  type WarrantyCoverage,
} from './warranty.ts';
import {
  resolveInsuranceExpiry,
  viewDoc,
  type InsurancePolicy,
  type ImportantDoc,
} from './vault.ts';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface VaultSettings {
  /** 全局默认退换政策天数（多数零售为 30），个别物品暂无单独字段 */
  returnPolicyDays?: number;
  /** 临期警戒天数，默认 30 */
  warnDays?: number;
}

/** D2 单一保险库：四类原始记录 + 可调设置 */
export interface D2Vault {
  items: PurchaseItem[];
  warranties: WarrantyCoverage[];
  insurances: InsurancePolicy[];
  docs: ImportantDoc[];
  settings?: VaultSettings;
}

export type TimelineKind =
  | 'return'             // 退换窗口
  | 'warranty'           // 质保到期
  | 'insurance-expiry'   // 保单到期
  | 'insurance-premium'  // 保费续费日
  | 'doc';               // 证件到期

export type TimelineStatus = 'expired' | 'expiring' | 'active' | 'no-expiry';

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  title: string;
  subtitle: string;
  /** 关键日期（ISO YYYY-MM-DD） */
  date: string;
  daysLeft: number;
  status: TimelineStatus;
  proofRef: string;
  /** 来源记录 id，供 UI 点击编辑 */
  sourceId: string;
}

export interface VaultStats {
  total: number;
  expired: number;
  expiring: number;
  active: number;
  noExpiry: number;
}

// ---------------------------------------------------------------------------

export function emptyVault(): D2Vault {
  return { items: [], warranties: [], insurances: [], docs: [], settings: {} };
}

function statusFromExpiry(
  expiry: string,
  refDate: string,
  warnDays: number,
): TimelineStatus {
  return coverageStatus(expiry, refDate, warnDays) as TimelineStatus;
}

/**
 * 生成首页时间轴。排序逻辑（按"需要行动的紧迫度"分组）：
 *   expiring（临期，越近越前） → expired（刚过期优先） → active（越近越前） → no-expiry
 */
export function buildTimeline(
  vault: D2Vault,
  refDate: string,
): TimelineEntry[] {
  const warnDays = vault.settings?.warnDays ?? 30;
  const returnDays = vault.settings?.returnPolicyDays ?? 30;
  const nameById = new Map(vault.items.map((it) => [it.id, it.name]));
  const out: TimelineEntry[] = [];

  // 1) 退换窗口：只保留仍在窗口内、或刚过期 7 天内的（避免老物品刷屏）
  for (const it of vault.items) {
    const dl = returnDeadline(it.purchaseDate, returnDays);
    if (!dl) continue;
    const left = daysBetween(dl, refDate);
    if (Number.isNaN(left) || left < -7) continue;
    out.push({
      id: `return:${it.id}`,
      kind: 'return',
      title: it.name,
      subtitle: 'Return window',
      date: dl,
      daysLeft: left,
      status: left < 0 ? 'expired' : left <= warnDays ? 'expiring' : 'active',
      proofRef: it.receiptRef ?? '',
      sourceId: it.id,
    });
  }

  // 2) 质保到期：每条覆盖单列（一物多保时用户能看到各自到期）
  for (const w of vault.warranties) {
    const v = viewCoverage(w, refDate, warnDays);
    if (!v.expiry || v.daysLeft === null) continue;
    out.push({
      id: `warranty:${w.id}`,
      kind: 'warranty',
      title: nameById.get(w.itemId) ?? w.itemId,
      subtitle: `Warranty · ${w.provider}`,
      date: v.expiry,
      daysLeft: v.daysLeft,
      status: v.status,
      proofRef: w.proofRef ?? '',
      sourceId: w.itemId,
    });
  }

  // 3) 保单到期 + 保费续费日
  for (const p of vault.insurances) {
    const expiry = resolveInsuranceExpiry(p);
    if (expiry) {
      const left = daysBetween(expiry, refDate);
      if (!Number.isNaN(left)) {
        out.push({
          id: `insurance-expiry:${p.id}`,
          kind: 'insurance-expiry',
          title: `${p.category} · ${p.provider}`,
          subtitle: `Policy ${p.policyNumber}`,
          date: expiry,
          daysLeft: left,
          status: statusFromExpiry(expiry, refDate, warnDays),
          proofRef: p.proofRef ?? '',
          sourceId: p.id,
        });
      }
    }
    if (p.premiumDueDate) {
      const left = daysBetween(p.premiumDueDate, refDate);
      if (!Number.isNaN(left)) {
        out.push({
          id: `insurance-premium:${p.id}`,
          kind: 'insurance-premium',
          title: `${p.category} · ${p.provider}`,
          subtitle: 'Premium due',
          date: p.premiumDueDate,
          daysLeft: left,
          status: statusFromExpiry(p.premiumDueDate, refDate, warnDays),
          proofRef: p.proofRef ?? '',
          sourceId: p.id,
        });
      }
    }
  }

  // 4) 证件到期（无有效期的证件 status = no-expiry，也进时间轴，排末尾）
  for (const d of vault.docs) {
    const v = viewDoc(d, refDate, warnDays);
    if (v.status === 'no-expiry') {
      out.push({
        id: `doc:${d.id}`,
        kind: 'doc',
        title: d.docType,
        subtitle: d.docNumber ? `No. ${d.docNumber}` : (d.issuer ?? 'Important document'),
        date: '',
        daysLeft: 0,
        status: 'no-expiry',
        proofRef: d.proofRef ?? '',
        sourceId: d.id,
      });
    } else if (v.daysToExpiry !== null) {
      out.push({
        id: `doc:${d.id}`,
        kind: 'doc',
        title: d.docType,
        subtitle: d.docNumber ? `No. ${d.docNumber}` : (d.issuer ?? 'Important document'),
        date: d.expiryDate ?? '',
        daysLeft: v.daysToExpiry,
        status: v.status as TimelineStatus,
        proofRef: d.proofRef ?? '',
        sourceId: d.id,
      });
    }
  }

  const groupRank: Record<TimelineStatus, number> = {
    expiring: 0, expired: 1, active: 2, 'no-expiry': 3,
  };
  out.sort((a, b) => {
    const g = groupRank[a.status] - groupRank[b.status];
    if (g !== 0) return g;
    if (a.status === 'expired') return b.daysLeft - a.daysLeft; // 刚过期在前
    if (a.status === 'no-expiry') return a.title.localeCompare(b.title);
    return a.daysLeft - b.daysLeft; // 越近越前
  });
  return out;
}

/** 首页顶部统计（按条目计，不按物品去重） */
export function vaultStats(vault: D2Vault, refDate: string): VaultStats {
  const entries = buildTimeline(vault, refDate);
  const s: VaultStats = { total: entries.length, expired: 0, expiring: 0, active: 0, noExpiry: 0 };
  for (const e of entries) {
    if (e.status === 'expired') s.expired++;
    else if (e.status === 'expiring') s.expiring++;
    else if (e.status === 'active') s.active++;
    else s.noExpiry++;
  }
  return s;
}

/** UI 用的天数文案（英文，海外上架默认语言） */
export function daysLabel(e: TimelineEntry): string {
  if (e.status === 'no-expiry') return 'No expiry';
  if (e.daysLeft < 0) return `Expired ${Math.abs(e.daysLeft)}d ago`;
  if (e.daysLeft === 0) return 'Due today';
  return `${e.daysLeft}d left`;
}
