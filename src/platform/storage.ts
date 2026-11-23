/**
 * 本地存储层：D2 单一保险库的四类记录只留在本机（AsyncStorage），
 * 无账号、无云同步、无网络请求。这是产品的核心卖点，改动前先读 需求/PRD.md。
 *
 * v0.2：从旧版"单表 receipts"升级为 D2 的"统一 vault"（items/warranties/insurances/docs）。
 * 旧 key 数据一次性迁移，不丢用户已有记录。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PurchaseItem, WarrantyCoverage } from '../warranty';
import type { InsurancePolicy, ImportantDoc } from '../vault';
import type { D2Vault } from '../aggregate';
import { emptyVault } from '../aggregate';

const KEY = 'surekeep.vault.v2';
const LEGACY_KEY = 'slipbox.receipts.v1';

const EMPTY = (): D2Vault => emptyVault();

/** 读取；损坏数据降级为空而非崩溃。兼容旧版 receipts keys。 */
export async function loadVault(): Promise<D2Vault> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<D2Vault>;
      return {
        items: Array.isArray(parsed.items) ? parsed.items : [],
        warranties: Array.isArray(parsed.warranties) ? parsed.warranties : [],
        insurances: Array.isArray(parsed.insurances) ? parsed.insurances : [],
        docs: Array.isArray(parsed.docs) ? parsed.docs : [],
        settings: parsed.settings ?? {},
      };
    }
    // 首次升级：迁移旧版收据表为 items
    const legacy = await AsyncStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as Array<Record<string, unknown>>;
      if (Array.isArray(old)) {
        const migrated: D2Vault = EMPTY();
        migrated.items = old.map((r) => ({
          id: String(r.id ?? `${Date.now()}-${Math.random()}`),
          name: String(r.merchant ?? 'Imported item'),
          merchant: String(r.merchant ?? ''),
          purchaseDate: String(r.date ?? new Date().toISOString().slice(0, 10)),
          amountCents: typeof r.totalCents === 'number' ? r.totalCents : null,
          currency: typeof r.currency === 'string' ? r.currency : undefined,
          receiptRef: typeof r.imageUri === 'string' ? r.imageUri : undefined,
          note: typeof r.note === 'string' ? r.note : undefined,
        })) as PurchaseItem[];
        await saveVault(migrated);
        return migrated;
      }
    }
  } catch {
    // 降级为空
  }
  return EMPTY();
}

export async function saveVault(v: D2Vault): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(v));
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
}

export async function putItem(item: PurchaseItem): Promise<D2Vault> {
  const v = await loadVault(); v.items = upsert(v.items, item); await saveVault(v); return v;
}
export async function putWarranty(w: WarrantyCoverage): Promise<D2Vault> {
  const v = await loadVault(); v.warranties = upsert(v.warranties, w); await saveVault(v); return v;
}
export async function putInsurance(p: InsurancePolicy): Promise<D2Vault> {
  const v = await loadVault(); v.insurances = upsert(v.insurances, p); await saveVault(v); return v;
}
export async function putDoc(d: ImportantDoc): Promise<D2Vault> {
  const v = await loadVault(); v.docs = upsert(v.docs, d); await saveVault(v); return v;
}

/** 删除时级联清掉该物品下的质保，避免孤儿数据 */
export async function deleteItem(id: string): Promise<D2Vault> {
  const v = await loadVault();
  v.items = v.items.filter((x) => x.id !== id);
  v.warranties = v.warranties.filter((w) => w.itemId !== id);
  await saveVault(v); return v;
}
export async function deleteWarranty(id: string): Promise<D2Vault> {
  const v = await loadVault(); v.warranties = v.warranties.filter((w) => w.id !== id);
  await saveVault(v); return v;
}
export async function deleteInsurance(id: string): Promise<D2Vault> {
  const v = await loadVault(); v.insurances = v.insurances.filter((p) => p.id !== id);
  await saveVault(v); return v;
}
export async function deleteDoc(id: string): Promise<D2Vault> {
  const v = await loadVault(); v.docs = v.docs.filter((d) => d.id !== id);
  await saveVault(v); return v;
}

/** 用户主动清空：仅提供入口，不做自动删除 */
export async function clearAll(): Promise<D2Vault> {
  await AsyncStorage.multiRemove([KEY, LEGACY_KEY]);
  return EMPTY();
}
