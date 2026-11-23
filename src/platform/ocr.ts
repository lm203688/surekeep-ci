/**
 * 原生能力适配层：文档扫描（VisionKit）+ 端侧 OCR（Apple Vision / ML Kit）
 *
 * 关键约束：
 *  - 两个库都含原生代码，**只能在 EAS Development Build 中运行，Expo Go 不可用**。
 *  - iOS 侧走 Apple VisionKit / Vision，全部在设备本地完成，不产生任何网络请求。
 *  - 本层用动态 require + 能力检测，保证某个原生模块缺失时给出可读错误，
 *    而不是在启动时白屏崩溃。
 */

export type OcrResult = {
  lines: string[];
  imageUri?: string;
};

export type ScanFailure =
  | { kind: 'cancelled' }
  | { kind: 'unsupported'; detail: string }
  | { kind: 'permission'; detail: string }
  | { kind: 'ocr'; detail: string };

export class ScanError extends Error {
  constructor(public readonly failure: ScanFailure) {
    super(failure.kind === 'cancelled' ? 'Scan cancelled' : failure.detail);
    this.name = 'ScanError';
  }
}

/** 扫描并识别一张/多张票据，返回 OCR 文本行 */
export async function scanAndRecognize(): Promise<OcrResult> {
  let scanDocument: (options?: object) => Promise<{ pages: Array<{ uri: string }> }>;
  let TextReader: { readDetailed: (uri: string, opts?: object) => Promise<{ fullText: string }> };

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ scanDocument } = require('expo-document-scanner'));
  } catch (e) {
    throw new ScanError({
      kind: 'unsupported',
      detail: 'Native document scanner unavailable. Run an EAS development build, not Expo Go.',
    });
  }

  let pages: Array<{ uri: string }>;
  try {
    const result = await scanDocument({ quality: 0.9, maxNumDocuments: 1 });
    pages = result.pages ?? [];
  } catch (e) {
    const msg = String(e);
    if (/cancel/i.test(msg)) throw new ScanError({ kind: 'cancelled' });
    if (/permission/i.test(msg)) {
      throw new ScanError({ kind: 'permission', detail: 'Camera permission is required to scan receipts.' });
    }
    throw new ScanError({ kind: 'unsupported', detail: msg });
  }

  if (pages.length === 0) throw new ScanError({ kind: 'cancelled' });

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    TextReader = require('react-native-text-reader').default;
  } catch (e) {
    throw new ScanError({
      kind: 'ocr',
      detail: 'On-device OCR module unavailable. Run an EAS development build.',
    });
  }

  try {
    const out = await TextReader.readDetailed(pages[0].uri, {
      recognitionLevel: 'accurate',
      recognitionLanguages: ['en-US'],
      useLanguageCorrection: false, // 收据含大量缩写/编码，语言纠错反而会改错
    });
    return {
      lines: out.fullText.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean),
      imageUri: pages[0].uri,
    };
  } catch (e) {
    throw new ScanError({ kind: 'ocr', detail: String(e) });
  }
}

/** 供 UI 展示的友好错误文案（英文，海外应用默认语言） */
export function scanErrorMessage(err: unknown): string {
  if (err instanceof ScanError) {
    switch (err.failure.kind) {
      case 'cancelled': return 'Scan cancelled.';
      case 'permission': return 'Please allow camera access in Settings to scan receipts.';
      case 'unsupported': return 'Scanner unavailable. Please update the app.';
      case 'ocr': return 'Could not read this receipt. Try better lighting or enter details manually.';
    }
  }
  return 'Something went wrong. Please try again.';
}
