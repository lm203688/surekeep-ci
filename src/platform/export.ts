/**
 * 导出层（D2 统一凭证包）：生成 CSV / JSON → 写本地缓存 → 调系统分享面板。
 * 不上传、不联网；用户自己决定把文件发给谁（保险公司 / 会计师 / 邮箱 / 文件 App）。
 *
 * v0.2：改用 vault.ts 的统一导出（质保+保险+证件），含 Excel 公式注入防护。
 */
// SDK 54：expo-file-system 新 API 移除了 cacheDirectory / EncodingType，
// 写缓存文件仍走 legacy 入口（同一模块，行为不变）。
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { D2Vault } from '../aggregate';
import { buildVaultExport, vaultExportToCsv, vaultExportToJson } from '../vault';

export type ExportFormat = 'csv' | 'json';

export async function exportVault(v: D2Vault, format: ExportFormat = 'csv'): Promise<void> {
  const exp = buildVaultExport(v.items, v.warranties, v.insurances, v.docs, todayISO());
  if (exp.rows.length === 0) throw new Error('Nothing to export yet.');
  const content = format === 'csv' ? vaultExportToCsv(exp) : vaultExportToJson(exp);
  const stamp = todayISO();
  const ext = format;
  const mime = format === 'csv' ? 'text/csv' : 'application/json';
  const uti = format === 'csv' ? 'public.comma-separated-values-text' : 'public.json';
  const path = `${FileSystem.cacheDirectory}surekeep-${stamp}.${ext}`;
  await FileSystem.writeAsStringAsync(path, content, { encoding: FileSystem.EncodingType.UTF8 });
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(path, { mimeType: mime, dialogTitle: 'Export records', UTI: uti });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
