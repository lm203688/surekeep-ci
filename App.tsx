/**
 * SureKeep — Offline Life Vault（质保 + 保险 + 重要证件）
 * v0.2：以"到期时间轴"为核心，四类记录一个 App 内闭环，不跨应用。
 * 设计原则：无账号、无云端、无广告、无追踪、零网络请求、首版全功能免费。
 * v1 只做手动录入；OCR/扫描原生层未经真机验证，暂不接入（见 测试/自测报告.md）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, SafeAreaView,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  buildTimeline, vaultStats, daysLabel, emptyVault,
  type D2Vault, type TimelineEntry,
} from './src/aggregate';
import {
  validateItem, validateWarranty,
  type PurchaseItem, type WarrantyCoverage,
  type WarrantyProvider, type DurationUnit,
} from './src/warranty';
import {
  validateInsurance, validateDoc,
  type InsurancePolicy, type ImportantDoc,
  type InsuranceCategory, type DocType,
} from './src/vault';
import {
  loadVault, putItem, putWarranty, putInsurance, putDoc,
  deleteItem, deleteWarranty, deleteInsurance, deleteDoc, clearAll,
} from './src/platform/storage';
import { exportVault, type ExportFormat } from './src/platform/export';
import FeedbackModal from './src/FeedbackModal';
import { useDuo } from './src/duo';

const INS_CATEGORIES: InsuranceCategory[] = ['auto', 'home', 'health', 'life', 'phone', 'travel', 'other'];
const DOC_TYPES: DocType[] = ['passport', 'id', 'driver-license', 'residence-permit', 'certificate', 'contract', 'other'];
const PROVIDERS: WarrantyProvider[] = ['manufacturer', 'store', 'extended', 'credit-card', 'other'];
const DURATIONS: DurationUnit[] = ['day', 'month', 'year'];

type EditorTarget =
  | { kind: 'item'; data: PurchaseItem; warranty: WarrantyCoverage | null }
  | { kind: 'insurance'; data: InsurancePolicy }
  | { kind: 'doc'; data: ImportantDoc };

export default function App() {
  const duo = useDuo();
  return (
    <View style={{ flex: 1, backgroundColor: '#F7F8F5', paddingRight: duo.gutter }}>
      <AppScreens />
    </View>
  );
}

function AppScreens() {
  const [vault, setVault] = useState<D2Vault>(emptyVault());
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);

  useEffect(() => {
    loadVault().then((v) => { setVault(v); setLoading(false); });
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const timeline = useMemo(() => buildTimeline(vault, today), [vault, today]);
  const stats = useMemo(() => vaultStats(vault, today), [vault, today]);

  const handleExport = useCallback(async (format: ExportFormat) => {
    try { await exportVault(vault, format); }
    catch (e) { Alert.alert('Export failed', String(e instanceof Error ? e.message : e)); }
  }, [vault]);

  const handleClear = useCallback(() => {
    Alert.alert('Delete all data?', 'Everything stored on this device will be removed. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete all', style: 'destructive', onPress: async () => setVault(await clearAll()) },
    ]);
  }, []);

  // ---- 编辑器保存 / 删除（封装到时间轴条目上） --------------------------------
  const openFromEntry = useCallback((e: TimelineEntry) => {
    if (e.kind === 'warranty' || e.kind === 'return') {
      const item = vault.items.find((x) => x.id === e.sourceId);
      if (!item) return;
      const w = vault.warranties.find((x) => x.itemId === item.id) ?? null;
      setEditor({ kind: 'item', data: item, warranty: w });
    } else if (e.kind === 'insurance-expiry' || e.kind === 'insurance-premium') {
      const p = vault.insurances.find((x) => x.id === e.sourceId);
      if (p) setEditor({ kind: 'insurance', data: p });
    } else if (e.kind === 'doc') {
      const d = vault.docs.find((x) => x.id === e.sourceId);
      if (d) setEditor({ kind: 'doc', data: d });
    }
  }, [vault]);

  const deleteFromEntry = useCallback((e: TimelineEntry) => {
    Alert.alert('Delete record?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        if (e.kind === 'warranty') setVault(await deleteWarranty(e.id.split(':')[1]));
        else if (e.kind === 'return') setVault(await deleteItem(e.sourceId));
        else if (e.kind.startsWith('insurance')) setVault(await deleteInsurance(e.sourceId));
        else setVault(await deleteDoc(e.sourceId));
      } },
    ]);
  }, []);

  const saveEditor = useCallback(async (target: EditorTarget) => {
    if (target.kind === 'item') {
      const errs = [...validateItem(target.data), ...(target.warranty ? validateWarranty(target.warranty) : [])];
      if (errs.length) { Alert.alert('Check fields', errs.join('\n')); return; }
      let v = await putItem(target.data);
      if (target.warranty) v = await putWarranty(target.warranty);
      setVault(v);
    } else if (target.kind === 'insurance') {
      const errs = validateInsurance(target.data);
      if (errs.length) { Alert.alert('Check fields', errs.join('\n')); return; }
      setVault(await putInsurance(target.data));
    } else {
      const errs = validateDoc(target.data);
      if (errs.length) { Alert.alert('Check fields', errs.join('\n')); return; }
      setVault(await putDoc(target.data));
    }
    setEditor(null);
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>SureKeep</Text>
          <Text style={styles.subtitle}>Your offline life vault</Text>
        </View>
        <Pressable onPress={() => setShowPrivacy(true)} style={styles.badge} accessibilityRole="button">
          <Text style={styles.badgeText}>On-device only</Text>
        </Pressable>
      </View>

      <View style={styles.statsRow}>
        <StatCard value={stats.expiring} label="Expiring soon" tone="warn" />
        <StatCard value={stats.expired} label="Expired" tone="bad" />
        <StatCard value={stats.active} label="Active" tone="good" />
        <StatCard value={stats.noExpiry} label="No expiry" tone="muted" />
      </View>

      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => setEditor({ kind: 'item', data: blankItem(), warranty: blankWarranty('') })} accessibilityRole="button">
          <Text style={styles.btnPrimaryText}>+ Purchase</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={() => setEditor({ kind: 'insurance', data: blankInsurance() })} accessibilityRole="button">
          <Text style={styles.btnSecondaryText}>+ Policy</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={() => setEditor({ kind: 'doc', data: blankDoc() })} accessibilityRole="button">
          <Text style={styles.btnSecondaryText}>+ Document</Text>
        </Pressable>
      </View>

      <View style={styles.exportBar}>
        <Text style={styles.exportLabel}>Claim / tax-ready export</Text>
        <Pressable onPress={() => handleExport('csv')} accessibilityRole="button"><Text style={styles.link}>CSV</Text></Pressable>
        <Text style={styles.dot}>·</Text>
        <Pressable onPress={() => handleExport('json')} accessibilityRole="button"><Text style={styles.link}>JSON</Text></Pressable>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.center} />
      ) : (
        <FlatList
          data={timeline}
          keyExtractor={(e) => e.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={<Text style={styles.sectionTitle}>WHAT NEEDS ATTENTION</Text>}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Nothing tracked yet</Text>
              <Text style={styles.emptyBody}>
                Add a purchase, policy or document. SureKeep shows what expires and when —
                everything stays on this device.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => openFromEntry(item)} onLongPress={() => deleteFromEntry(item)}>
              <View style={[styles.statusBar, statusColor(item.status)]} />
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.rowMeta} numberOfLines={1}>{item.subtitle} · {item.date || 'no date'}</Text>
              </View>
              <Text style={[styles.rowDays, statusTextColor(item.status)]}>{daysLabel(item)}</Text>
            </Pressable>
          )}
        />
      )}

      <Modal visible={editor !== null} animationType="slide" presentationStyle="pageSheet">
        {editor?.kind === 'item' && (
          <ItemEditor target={editor} vault={vault} onCancel={() => setEditor(null)} onSave={saveEditor} />
        )}
        {editor?.kind === 'insurance' && (
          <InsuranceEditor target={editor} onCancel={() => setEditor(null)} onSave={saveEditor} />
        )}
        {editor?.kind === 'doc' && (
          <DocEditor target={editor} onCancel={() => setEditor(null)} onSave={saveEditor} />
        )}
      </Modal>

      <Modal visible={showPrivacy} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Your privacy</Text>
            <Pressable onPress={() => setShowPrivacy(false)}><Text style={styles.link}>Done</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.privacyBody}>
            <Text style={styles.privacyH}>Nothing leaves your phone</Text>
            <Text style={styles.privacyP}>
              SureKeep stores your purchases, policies and documents only on this device.
              There is no account, no sign-in, no cloud sync, no analytics, no advertising SDK,
              and no network request of any kind.
            </Text>
            <Text style={styles.privacyH}>You are in control</Text>
            <Text style={styles.privacyP}>
              Edit or delete any entry, or erase everything at once. Exporting a claim-ready
              CSV / JSON is something you do explicitly — the app never sends data anywhere.
            </Text>
            <Text style={styles.privacyH}>App Store privacy label</Text>
            <Text style={styles.privacyP}>Data Not Collected.</Text>
            <Pressable style={styles.dangerBtn} onPress={handleClear}>
              <Text style={styles.dangerText}>Delete all data on this device</Text>
            </Pressable>
            <Pressable onPress={() => setShowFeedback(true)} accessibilityRole="button" style={{ paddingVertical: 12 }}>
              <Text style={styles.link}>Send feedback</Text>
            </Pressable>
            <Text style={styles.version}>SureKeep 0.2.0 · no account, no subscription, no ads</Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <FeedbackModal visible={showFeedback} onClose={() => setShowFeedback(false)} context="privacy" />
    </SafeAreaView>
  );
}

// --------------------------------------------------------------------------- 编辑器组件

function ItemEditor({ target, vault, onCancel, onSave }: {
  target: Extract<EditorTarget, { kind: 'item' }>;
  vault: D2Vault;
  onCancel: () => void;
  onSave: (t: EditorTarget) => void;
}) {
  const [item, setItem] = useState(target.data);
  const [w, setW] = useState<WarrantyCoverage | null>(target.warranty);
  const patch = (p: Partial<PurchaseItem>) => setItem((x) => ({ ...x, ...p }));
  const patchW = (p: Partial<WarrantyCoverage>) => setW((x) => x ? { ...x, ...p } : x);
  return (
    <SafeAreaView style={styles.modalRoot}>
      <View style={styles.modalHeader}>
        <Pressable onPress={onCancel}><Text style={styles.link}>Cancel</Text></Pressable>
        <Text style={styles.modalTitle}>Purchase</Text>
        <Pressable onPress={() => onSave({ kind: 'item', data: item, warranty: w })}>
          <Text style={[styles.link, styles.linkBold]}>Save</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.form}>
        <Field label="Item name"><TextInput style={styles.input} value={item.name} placeholder="e.g. Laptop"
          placeholderTextColor="#9aa0a6" onChangeText={(v) => patch({ name: v })} /></Field>
        <Field label="Merchant"><TextInput style={styles.input} value={item.merchant} placeholder="Where bought"
          placeholderTextColor="#9aa0a6" onChangeText={(v) => patch({ merchant: v })} /></Field>
        <Field label="Purchase date (YYYY-MM-DD)"><TextInput style={styles.input} value={item.purchaseDate}
          placeholder="2026-11-16" placeholderTextColor="#9aa0a6" keyboardType="numbers-and-punctuation"
          onChangeText={(v) => patch({ purchaseDate: v })} /></Field>
        <Field label="Amount"><TextInput style={styles.input} keyboardType="decimal-pad" placeholder="0.00"
          placeholderTextColor="#9aa0a6" value={item.amountCents == null ? '' : (item.amountCents / 100).toFixed(2)}
          onChangeText={(v) => patch({ amountCents: v.trim() === '' ? null : Math.round(parseFloat(v.replace(',', '.')) * 100) || null })} /></Field>
        <Field label="Note"><TextInput style={[styles.input, styles.multiline]} value={item.note ?? ''}
          placeholder="Optional" placeholderTextColor="#9aa0a6" multiline onChangeText={(v) => patch({ note: v })} /></Field>

        <View style={styles.divider} />
        <Text style={styles.subHead}>Warranty / return coverage</Text>
        <Pressable style={styles.toggleRow} onPress={() => {
          if (w) setW(null);
          else setW(blankWarranty(item.id));
        }}>
          <Text style={styles.link}>{w ? '− Remove warranty' : '+ Add warranty'}</Text>
        </Pressable>
        {w && (
          <>
            <Field label="Provider">
              <View style={styles.chips}>
                {PROVIDERS.map((p) => <Chip key={p} label={p} active={w.provider === p}
                  onPress={() => patchW({ provider: p })} />)}
              </View>
            </Field>
            <Field label="Start date (YYYY-MM-DD)"><TextInput style={styles.input} value={w.startDate}
              placeholder="2026-11-16" placeholderTextColor="#9aa0a6"
              onChangeText={(v) => patchW({ startDate: v })} /></Field>
            <View style={styles.row2}>
              <View style={styles.flex1}>
                <Field label="Duration"><TextInput style={styles.input} keyboardType="number-pad"
                  value={String(w.durationValue)} placeholderTextColor="#9aa0a6"
                  onChangeText={(v) => patchW({ durationValue: parseInt(v, 10) || 0 })} /></Field>
              </View>
              <View style={styles.flex1}>
                <Field label="Unit">
                  <View style={styles.chips}>
                    {DURATIONS.map((u) => <Chip key={u} label={u} active={w.durationUnit === u}
                      onPress={() => patchW({ durationUnit: u })} />)}
                  </View>
                </Field>
              </View>
            </View>
          </>
        )}
        <Text style={styles.formFoot}>Stored only on this device. Nothing is uploaded.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function InsuranceEditor({ target, onCancel, onSave }: {
  target: Extract<EditorTarget, { kind: 'insurance' }>;
  onCancel: () => void;
  onSave: (t: EditorTarget) => void;
}) {
  const [p, setP] = useState(target.data);
  const patch = (x: Partial<InsurancePolicy>) => setP((v) => ({ ...v, ...x }));
  return (
    <SafeAreaView style={styles.modalRoot}>
      <View style={styles.modalHeader}>
        <Pressable onPress={onCancel}><Text style={styles.link}>Cancel</Text></Pressable>
        <Text style={styles.modalTitle}>Insurance policy</Text>
        <Pressable onPress={() => onSave({ kind: 'insurance', data: p })}>
          <Text style={[styles.link, styles.linkBold]}>Save</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.form}>
        <Field label="Category">
          <View style={styles.chips}>
            {INS_CATEGORIES.map((c) => <Chip key={c} label={c} active={p.category === c}
              onPress={() => patch({ category: c })} />)}
          </View>
        </Field>
        <Field label="Provider"><TextInput style={styles.input} value={p.provider} placeholder="e.g. Geico"
          placeholderTextColor="#9aa0a6" onChangeText={(v) => patch({ provider: v })} /></Field>
        <Field label="Policy number"><TextInput style={styles.input} value={p.policyNumber} placeholder="A-123"
          placeholderTextColor="#9aa0a6" onChangeText={(v) => patch({ policyNumber: v })} /></Field>
        <Field label="Expiry date (YYYY-MM-DD)"><TextInput style={styles.input} value={p.expiryDate ?? ''}
          placeholder="2027-01-01" placeholderTextColor="#9aa0a6"
          onChangeText={(v) => patch({ expiryDate: v || undefined })} /></Field>
        <Field label="Premium due (YYYY-MM-DD)"><TextInput style={styles.input} value={p.premiumDueDate ?? ''}
          placeholder="2026-12-01" placeholderTextColor="#9aa0a6"
          onChangeText={(v) => patch({ premiumDueDate: v || undefined })} /></Field>
        <Field label="Note"><TextInput style={[styles.input, styles.multiline]} value={p.note ?? ''}
          placeholder="Optional" placeholderTextColor="#9aa0a6" multiline onChangeText={(v) => patch({ note: v })} /></Field>
        <Text style={styles.formFoot}>Stored only on this device. Nothing is uploaded.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function DocEditor({ target, onCancel, onSave }: {
  target: Extract<EditorTarget, { kind: 'doc' }>;
  onCancel: () => void;
  onSave: (t: EditorTarget) => void;
}) {
  const [d, setD] = useState(target.data);
  const patch = (x: Partial<ImportantDoc>) => setD((v) => ({ ...v, ...x }));
  return (
    <SafeAreaView style={styles.modalRoot}>
      <View style={styles.modalHeader}>
        <Pressable onPress={onCancel}><Text style={styles.link}>Cancel</Text></Pressable>
        <Text style={styles.modalTitle}>Important document</Text>
        <Pressable onPress={() => onSave({ kind: 'doc', data: d })}>
          <Text style={[styles.link, styles.linkBold]}>Save</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.form}>
        <Field label="Document type">
          <View style={styles.chips}>
            {DOC_TYPES.map((t) => <Chip key={t} label={t} active={d.docType === t}
              onPress={() => patch({ docType: t })} />)}
          </View>
        </Field>
        <Field label="Document number"><TextInput style={styles.input} value={d.docNumber ?? ''}
          placeholder="Optional" placeholderTextColor="#9aa0a6" onChangeText={(v) => patch({ docNumber: v })} /></Field>
        <Field label="Issuer"><TextInput style={styles.input} value={d.issuer ?? ''}
          placeholder="e.g. DMV" placeholderTextColor="#9aa0a6" onChangeText={(v) => patch({ issuer: v })} /></Field>
        <Field label="Expiry date (YYYY-MM-DD)"><TextInput style={styles.input} value={d.expiryDate ?? ''}
          placeholder="Leave empty if no expiry" placeholderTextColor="#9aa0a6"
          onChangeText={(v) => patch({ expiryDate: v || undefined })} /></Field>
        <Field label="Note"><TextInput style={[styles.input, styles.multiline]} value={d.note ?? ''}
          placeholder="Optional" placeholderTextColor="#9aa0a6" multiline onChangeText={(v) => patch({ note: v })} /></Field>
        <Text style={styles.formFoot}>Stored only on this device. Nothing is uploaded.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// --------------------------------------------------------------------------- 小组件 / 工厂

function StatCard({ value, label, tone }: { value: number; label: string; tone: string }) {
  const color = tone === 'bad' ? '#B33838' : tone === 'warn' ? '#B4801A' : tone === 'good' ? '#2F6B3C' : '#7C867F';
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}
function uid(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function blankItem(): PurchaseItem {
  return { id: uid('i'), name: '', merchant: '', purchaseDate: new Date().toISOString().slice(0, 10), amountCents: null };
}
function blankWarranty(itemId: string): WarrantyCoverage {
  return { id: uid('w'), itemId, provider: 'manufacturer', startDate: new Date().toISOString().slice(0, 10), durationValue: 1, durationUnit: 'year' };
}
function blankInsurance(): InsurancePolicy {
  return { id: uid('p'), category: 'auto', provider: '', policyNumber: '', expiryDate: '' };
}
function blankDoc(): ImportantDoc {
  return { id: uid('d'), docType: 'passport' };
}
function statusColor(s: string) {
  return { backgroundColor: s === 'expired' ? '#B33838' : s === 'expiring' ? '#E0A320' : s === 'active' ? '#3E8E54' : '#C7CDC8' };
}
function statusTextColor(s: string) {
  return { color: s === 'expired' ? '#B33838' : s === 'expiring' ? '#9A6B0E' : s === 'active' ? '#2F6B3C' : '#9AA39B' };
}

// --------------------------------------------------------------------------- 样式

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F7F8F5' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingBottom: 12 },
  title: { fontSize: 28, fontWeight: '700', color: '#1B2B20', letterSpacing: -0.5 },
  subtitle: { fontSize: 13, color: '#6B756E', marginTop: 2 },
  badge: { backgroundColor: '#E1F0E4', paddingHorizontal: 11, paddingVertical: 6, borderRadius: 20 },
  badgeText: { fontSize: 11, color: '#2F6B3C', fontWeight: '600' },
  statsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  statCard: { flex: 1, backgroundColor: '#FFF', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#EAEEE7' },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: { fontSize: 10, color: '#7C867F', marginTop: 2, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 8, padding: 16, paddingBottom: 6 },
  btn: { paddingVertical: 11, paddingHorizontal: 10, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#2F6B3C', flex: 1.2, minHeight: 44 },
  btnPrimaryText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  btnSecondary: { backgroundColor: '#FFFFFF', flex: 1, borderWidth: 1, borderColor: '#DCE3DA' },
  btnSecondaryText: { color: '#22432D', fontWeight: '600', fontSize: 13 },
  exportBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 6, gap: 8 },
  exportLabel: { fontSize: 12, color: '#6B756E', flex: 1 },
  dot: { color: '#C7CDC8' },
  link: { fontSize: 14, color: '#2F6B3C', fontWeight: '600' },
  linkBold: { fontWeight: '700' },
  center: { marginTop: 40 },
  list: { padding: 16, paddingTop: 4, paddingBottom: 40 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: '#9AA39B', letterSpacing: 1, marginBottom: 8 },
  row: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, marginBottom: 9, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#EAEEE7', overflow: 'hidden' },
  statusBar: { width: 4, height: 38, borderRadius: 2, marginRight: 12 },
  rowMain: { flex: 1, marginRight: 10 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: '#1B2B20' },
  rowMeta: { fontSize: 11, color: '#7C867F', marginTop: 3 },
  rowDays: { fontSize: 13, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 30 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: '#1B2B20' },
  emptyBody: { fontSize: 13, color: '#7C867F', textAlign: 'center', marginTop: 8, lineHeight: 19 },
  modalRoot: { flex: 1, backgroundColor: '#F7F8F5' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 18, borderBottomWidth: 1, borderBottomColor: '#E4EAE1', backgroundColor: '#FFF' },
  modalTitle: { fontSize: 16, fontWeight: '600', color: '#1B2B20' },
  form: { padding: 18, paddingBottom: 50 },
  field: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, color: '#6B756E', marginBottom: 6, fontWeight: '600' },
  input: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DCE3DA', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, fontSize: 15, color: '#1B2B20' },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 8, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DCE3DA' },
  chipActive: { backgroundColor: '#22432D', borderColor: '#22432D' },
  chipText: { fontSize: 12, color: '#4A554D' },
  chipTextActive: { color: '#FFF', fontWeight: '600' },
  divider: { height: 1, backgroundColor: '#E4EAE1', marginVertical: 18 },
  subHead: { fontSize: 14, fontWeight: '700', color: '#1B2B20', marginBottom: 8 },
  toggleRow: { marginBottom: 12 },
  row2: { flexDirection: 'row', gap: 10 },
  flex1: { flex: 1 },
  formFoot: { fontSize: 11, color: '#8E988F', textAlign: 'center', marginTop: 16, lineHeight: 16 },
  privacyBody: { padding: 22 },
  privacyH: { fontSize: 16, fontWeight: '700', color: '#1B2B20', marginTop: 18, marginBottom: 6 },
  privacyP: { fontSize: 14, color: '#4A554D', lineHeight: 21 },
  dangerBtn: { marginTop: 34, padding: 14, borderRadius: 10, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E8B4B4', alignItems: 'center' },
  dangerText: { color: '#B33838', fontSize: 14, fontWeight: '600' },
  version: { fontSize: 11, color: '#9AA39B', textAlign: 'center', marginTop: 26 },
});
