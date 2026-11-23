// Feedback loop primitives — shared port (copy into <product>/代码/src/feedback.ts).
// Pure functions, no network, no storage. Nothing here uploads anything: the app
// builds a bundle, shows it to the user, and hands it to their own mail client /
// share sheet. Only ids and codes travel, never inputs, never photos.
//
// Per-product knobs — edit only the CONFIG block below.
//   app        product name shown in the report
//   prefix     id prefix ("SM" -> SM-0001)
//   tag        mail subject tag
//   address    developer inbox
//   categories chip keys, in display order
//   labels     key -> English chip label

export const CONFIG = {
  app: 'SureKeep',
  prefix: 'SK',
  tag: 'SureKeep',
  address: '463102527@qq.com',
  categories: ['data_loss', 'unlock_issue', 'crash', 'hard_to_use', 'new_request', 'other'],
  labels: {
    data_loss: 'Records missing',
    unlock_issue: 'Cannot unlock',
    crash: 'Crash',
    hard_to_use: 'Hard to use',
    new_request: 'Idea',
    other: 'Other',
  },
};

export const CATEGORIES = CONFIG.categories;
export const CATEGORY_LABELS = CONFIG.labels;
export const FEEDBACK_EMAIL = CONFIG.address;
export const MAX_ACTIONS = 20;
export const MAX_NOTE = 1200;

export type Session = {
  app: string;
  version: string;
  build: string;
  device: string;
  os: string;
  locale: string;
  startedAt: string;
  actions: string[];
  errorCode: string | null;
};

export type Meta = {
  version?: string;
  build?: string;
  device?: string;
  os?: string;
  locale?: string;
};

export type Bundle = {
  id?: string;
  app: string;
  version: string;
  build: string;
  device: string;
  os: string;
  locale: string;
  context: string | null;
  last_actions: string[];
  error_code: string | null;
  category: string;
  user_note: string;
  created_at: string;
};

export function createSession(meta: Meta = {}): Session {
  return {
    app: CONFIG.app,
    version: meta.version || '1.0.0',
    build: meta.build || '1',
    device: meta.device || '',
    os: meta.os || '',
    locale: meta.locale || 'en-US',
    startedAt: new Date().toISOString(),
    actions: [],
    errorCode: null,
  };
}

// Ring buffer of screen/tool ids only — never inputs, never free text, never photos.
export function recordAction(session: Session | null, id: string): Session | null {
  if (!session || typeof id !== 'string' || !id) return session;
  session.actions.push(id);
  if (session.actions.length > MAX_ACTIONS) session.actions.shift();
  return session;
}

export function buildBundle(
  input: { category?: string; note?: string; context?: string | null; errorCode?: string | null } = {},
  meta: Meta = {},
  session?: Session | null
): Bundle {
  const s = session || createSession(meta);
  const category = CONFIG.categories.includes(input.category as string) ? (input.category as string) : 'other';
  const note = typeof input.note === 'string' ? input.note.slice(0, MAX_NOTE) : '';
  return {
    app: s.app,
    version: meta.version || s.version,
    build: meta.build || s.build,
    device: meta.device || s.device,
    os: meta.os || s.os,
    locale: meta.locale || s.locale,
    context: typeof input.context === 'string' ? input.context : null,
    last_actions: s.actions.slice(-MAX_ACTIONS),
    error_code: input.errorCode || s.errorCode || null,
    category,
    user_note: note,
    created_at: new Date().toISOString(),
  };
}

export function nextId(existing: string[] = [], prefix: string = CONFIG.prefix): string {
  let max = 0;
  for (const id of existing) {
    const m = /^([A-Z]+)-(\d{4})$/.exec(String(id));
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

export function validateBundle(b: Bundle): string[] {
  const errors: string[] = [];
  if (!b || typeof b !== 'object') return ['bundle must be an object'];
  (['app', 'version', 'build', 'locale', 'category', 'created_at'] as const).forEach((k) => {
    if (!(b as any)[k]) errors.push(`missing ${k}`);
  });
  if (!CONFIG.categories.includes(b.category)) errors.push('unknown category');
  if (Array.isArray(b.last_actions)) {
    if (b.last_actions.length > MAX_ACTIONS) errors.push('too many actions');
    if (b.last_actions.some((a) => typeof a !== 'string')) errors.push('actions must be ids');
  } else errors.push('last_actions must be an array');
  if (typeof b.user_note === 'string' && b.user_note.length > MAX_NOTE) errors.push('note too long');
  return errors;
}

// Plain-text body: readable in any mail client, and editable by the user before sending.
export function toText(b: Bundle): string {
  return [
    `Feedback ${b.id || ''}`.trim(),
    `App: ${b.app} ${b.version} (build ${b.build})`,
    `Device: ${b.device} | OS: ${b.os} | Locale: ${b.locale}`,
    `Category: ${b.category}`,
    `Context: ${b.context || 'n/a'}`,
    `Error code: ${b.error_code || 'n/a'}`,
    `Recent screens: ${(b.last_actions || []).join(' > ') || 'n/a'}`,
    '',
    'What happened:',
    b.user_note || '(describe what you expected and what you saw)',
    '',
    '— No photos, texts or personal data are included. You can edit this before sending.',
  ].join('\n');
}

export function toMailto(b: Bundle, address: string = CONFIG.address): string {
  const subject = `[${CONFIG.tag}] ${b.category} · ${b.version} · ${b.id || 'draft'}`;
  const body = toText(b);
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
