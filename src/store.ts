import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  fieldByUid,
  makeField,
  mergeStates,
  rebaseDraft,
  validateDraft,
  type Draft,
  type FormField,
  type FormVersion,
  type KeyMapping,
  type LinkRule,
  type SchemaState,
  type Snapshot,
} from './model';

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const nextId = (prefix: string, list: { id: string }[]) =>
  `${prefix}${Math.max(0, ...list.map((item) => Number(item.id.replace(/\D/g, '')) || 0)) + 1}`;

const field = (uid: string, key: string, label: string, rest: Partial<FormField> = {}): FormField => ({
  uid, key, label, type: 'text', required: false, ...rest,
});

const v1: FormVersion = {
  id: 'v1', revision: 1, label: '费用申请 v1', createdAt: '2026-08-12', frozenAt: '2026-08-12T00:00:00.000Z',
  fields: [
    field('f-name', 'name', '申请名称', { type: 'text', required: true }),
    field('f-department', 'department', '申请部门', { type: 'select', required: true, options: ['研发', '市场', '财务'] }),
    field('f-amount', 'amount', '申请金额', { type: 'number', required: true }),
  ],
  rules: [],
  mappings: [],
};

const v2: FormVersion = {
  id: 'v2', revision: 2, label: '费用申请 v2', createdAt: '2026-09-28', frozenAt: '2026-09-28T00:00:00.000Z',
  fields: [
    field('f-department', 'department', '申请部门', { type: 'select', required: true, options: ['研发', '市场', '财务'] }),
    field('f-name', 'name', '申请名称', { type: 'text', required: true }),
    field('f-budget', 'budgetCode', '预算科目', { type: 'text', required: false }),
    field('f-amount', 'amount', '申请金额', { type: 'number', required: true }),
    field('f-invoice', 'invoiceDate', '预计开票日期', { type: 'date', required: false }),
  ],
  rules: [
    { id: 'r1', sourceKey: 'department', operator: 'equals', value: '财务', effect: 'require', targetKey: 'budgetCode' },
    { id: 'r2', sourceKey: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetKey: 'invoiceDate' },
  ],
  mappings: [],
};

function seedDraft(): Draft {
  return {
    id: 'd1',
    baselineRevision: 2,
    fields: structuredClone(v2.fields),
    rules: structuredClone(v2.rules),
    mappings: [],
    pendingMappings: [],
    updatedAt: Date.now(),
  };
}

const initial: SchemaState = {
  revision: 2,
  versions: [v1, v2],
  snapshots: [
    { id: 's1', versionId: 'v1', createdAt: '2026-08-15', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
    { id: 's2', versionId: 'v1', createdAt: '2026-08-20', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } },
    { id: 's3', versionId: 'v2', createdAt: '2026-09-30', label: '九月差旅报销', data: { department: '研发', name: '客户走访', budgetCode: '', amount: '8300', invoiceDate: '2026-10-08' } },
  ],
  drafts: [seedDraft()],
  activeDraftId: 'd1',
};

const STORAGE_KEY = 'yf55-schema-state-v2';

export interface PublishOutcome {
  ok: boolean;
  versionId?: string;
  reason?: string;
  issues?: ReturnType<typeof validateDraft>;
  /** 基线被别的标签页抢先发布改变：草稿保住，需要重新比对 */
  stale?: boolean;
}

interface SliceState extends SchemaState {
  /** 非持久化的瞬时 UI 反馈 */
  lastPublish: PublishOutcome | null;
  rebasedFromRevision: number | null;
}

const slice = createSlice({
  name: 'schema',
  initialState: { ...initial, lastPublish: null, rebasedFromRevision: null } as SliceState,
  reducers: {
    reorderFields(state, action: PayloadAction<{ draftId: string; activeUid: string; overUid: string }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      const from = draft.fields.findIndex((f) => f.uid === action.payload.activeUid);
      const to = draft.fields.findIndex((f) => f.uid === action.payload.overUid);
      if (from < 0 || to < 0) return;
      const [moved] = draft.fields.splice(from, 1);
      draft.fields.splice(to, 0, moved);
      touch(draft);
    },
    addField(state, action: PayloadAction<{ draftId: string }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      draft.fields.push(makeField('field'));
      touch(draft);
    },
    updateField(state, action: PayloadAction<{ draftId: string; uid: string; patch: Partial<Pick<FormField, 'label' | 'type' | 'required'>> }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      const target = draft && fieldByUid(draft.fields, action.payload.uid);
      if (!target) return;
      // 只允许改显示层属性；改 key 必须走登记对照
      Object.assign(target, action.payload.patch);
      touch(draft);
    },
    addRule(state, action: PayloadAction<{ draftId: string; rule: Omit<LinkRule, 'id'> }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      draft.rules.push({ ...action.payload.rule, id: nextId('r', draft.rules) });
      touch(draft);
    },
    removeRule(state, action: PayloadAction<{ draftId: string; ruleId: string }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      draft.rules = draft.rules.filter((r) => r.id !== action.payload.ruleId);
      touch(draft);
    },
    /** 开始登记一条标识对照（“没做完”状态）：立刻持久化，断了也能接着处理 */
    beginRenameKey(state, action: PayloadAction<{ draftId: string; uid: string; newKey: string }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      const target = draft && fieldByUid(draft.fields, action.payload.uid);
      if (!draft || !target) return;
      // 同一字段重开编辑：替换上一条没做完的
      draft.pendingMappings = draft.pendingMappings.filter((m) => m.fieldUid !== action.payload.uid);
      draft.pendingMappings.push({
        id: nextId('p', [...draft.mappings, ...draft.pendingMappings]),
        fieldUid: target.uid,
        oldKey: target.key,
        newKey: action.payload.newKey,
        createdAt: nowIso(),
      });
      touch(draft);
    },
    updatePendingMapping(state, action: PayloadAction<{ draftId: string; pendingId: string; newKey: string }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      const pending = draft?.pendingMappings.find((m) => m.id === action.payload.pendingId);
      if (!draft || !pending) return;
      pending.newKey = action.payload.newKey;
      touch(draft);
    },
    /** 取消没做完的对照：字段维持原标识，什么都没发生 */
    cancelPendingMapping(state, action: PayloadAction<{ draftId: string; pendingId: string }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      draft.pendingMappings = draft.pendingMappings.filter((m) => m.id !== action.payload.pendingId);
      touch(draft);
    },
    /**
     * 完成对照：新标识生效、对照冻结进待发布清单、引用该标识的联动自动重算。
     */
    commitPendingMapping(state, action: PayloadAction<{ draftId: string; pendingId: string }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      const index = draft.pendingMappings.findIndex((m) => m.id === action.payload.pendingId);
      if (index < 0) return;
      const pending = draft.pendingMappings[index];
      const target = fieldByUid(draft.fields, pending.fieldUid);
      if (!target) {
        draft.pendingMappings.splice(index, 1);
        return;
      }
      const newKey = pending.newKey.trim();
      // 实时撞车拦截（发布时 validateDraft 还会兜底）
      const clashField = draft.fields.find((f) => f.uid !== target.uid && f.key === newKey);
      const clashPending = draft.pendingMappings.find((m) => m.id !== pending.id && m.newKey === newKey);
      if (!newKey || clashField || clashPending || target.key === newKey) return;

      // 引用旧标识的联动提示全部重算到新标识
      for (const rule of draft.rules) {
        if (rule.sourceKey === pending.oldKey) rule.sourceKey = newKey;
        if (rule.targetKey === pending.oldKey) rule.targetKey = newKey;
      }
      target.key = newKey;
      const frozen: KeyMapping = { ...pending, newKey };
      draft.mappings.push(frozen);
      draft.pendingMappings.splice(index, 1);
      touch(draft);
    },
    /**
     * 发布：校验撞车/半成品 → 基线并发检查 → 冻结版本。
     * 任何错误都停下并把具体条目写入 lastPublish；基线变了则保住草稿、rebase 后提示重新比对。
     */
    publishVersion(state, action: PayloadAction<{ draftId: string }>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) {
        state.lastPublish = { ok: false, reason: '草稿不存在。' };
        return;
      }

      // 1) 基线并发检查：别的标签页已经发布过新版本
      const latest = state.versions[state.versions.length - 1];
      if (latest.revision !== draft.baselineRevision) {
        const from = draft.baselineRevision;
        Object.assign(draft, rebaseDraft(draft, latest));
        state.rebasedFromRevision = from;
        state.lastPublish = {
          ok: false,
          stale: true,
          reason: `基线已从 v${from} 变为 v${latest.revision}（另一标签页已发布）。草稿已原样保留并并入最新基线，请重新比对差异后再发布。`,
        };
        return;
      }

      // 2) 撞车与半成品校验：出错立即停下，指出哪几条
      const issues = validateDraft(draft);
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length > 0) {
        state.lastPublish = { ok: false, reason: '发布已停下，请先处理以下问题。', issues };
        return;
      }

      // 3) 冻结这一版的标识：剔除悬空联动，快照式存档
      const revision = state.revision + 1;
      const version: FormVersion = {
        id: `v${revision}`,
        revision,
        label: `费用申请 v${revision}`,
        createdAt: today(),
        frozenAt: nowIso(),
        fields: structuredClone(draft.fields),
        rules: structuredClone(
          draft.rules.filter((r) =>
            draft.fields.some((f) => f.key === r.sourceKey) && draft.fields.some((f) => f.key === r.targetKey)),
        ),
        mappings: structuredClone(draft.mappings),
      };
      state.versions.push(version);
      state.revision = revision;

      // 当前草稿推进到新基线；对照已随版本冻结，草稿清单清空
      draft.baselineRevision = revision;
      draft.mappings = [];
      draft.pendingMappings = [];
      draft.updatedAt = Date.now();
      state.lastPublish = {
        ok: true,
        versionId: version.id,
        issues: issues.filter((i) => i.level === 'warning'),
      };
      state.rebasedFromRevision = null;
    },
    clearPublishFeedback(state) {
      state.lastPublish = null;
      state.rebasedFromRevision = null;
    },
    submitSnapshot(state, action: PayloadAction<{ versionId: string; label: string; data: Record<string, string> }>) {
      state.snapshots.push({
        id: nextId('s', state.snapshots),
        versionId: action.payload.versionId,
        createdAt: today(),
        label: action.payload.label,
        data: action.payload.data,
      });
    },
    selectDraft(state, action: PayloadAction<string>) {
      state.activeDraftId = action.payload;
    },
    /** 复制一份同基线草稿，用来模拟另一个标签页同时在编辑、并发发布 */
    cloneDraft(state, action: PayloadAction<{ draftId: string }>) {
      const source = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!source) return;
      const id = nextId('d', state.drafts);
      state.drafts.push({ ...structuredClone(source), id, updatedAt: Date.now() });
      state.activeDraftId = id;
    },
    /** 跨标签页同步：合并另一份状态 */
    hydrateFromStorage(state, action: PayloadAction<SchemaState>) {
      const merged = mergeStates(
        { revision: state.revision, versions: state.versions, snapshots: state.snapshots, drafts: state.drafts, activeDraftId: state.activeDraftId },
        action.payload,
      );
      state.revision = merged.revision;
      state.versions = merged.versions;
      state.snapshots = merged.snapshots;
      state.drafts = merged.drafts;
    },
    replaceState(_state, action: PayloadAction<SchemaState>) {
      return { ...action.payload, lastPublish: null, rebasedFromRevision: null };
    },
  },
});

function touch(draft: Draft) {
  draft.updatedAt = Date.now();
}

export const {
  addField,
  addRule,
  beginRenameKey,
  cancelPendingMapping,
  clearPublishFeedback,
  cloneDraft,
  commitPendingMapping,
  hydrateFromStorage,
  publishVersion,
  removeRule,
  reorderFields,
  replaceState,
  selectDraft,
  submitSnapshot,
  updateField,
  updatePendingMapping,
} = slice.actions;

export const store = configureStore({ reducer: { schema: slice.reducer } });

// ---- 持久化：保存中途断掉（含没做完的对照）重开还能接着处理 ----
function persist() {
  if (typeof localStorage === 'undefined') return;
  const s = store.getState().schema;
  const { lastPublish: _lp, rebasedFromRevision: _rb, ...persisted } = s;
  void _lp; void _rb;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted satisfies SchemaState));
}

if (typeof localStorage !== 'undefined') {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
    } catch {
      // 坏数据不阻塞，沿用种子
    }
  }
  store.subscribe(persist);

  // ---- 两个标签页同时开：storage 事件同步；发布时按基线版本决定谁要重新比对 ----
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      store.dispatch(hydrateFromStorage(JSON.parse(event.newValue) as SchemaState));
    } catch {
      // 忽略无法解析的外部写入
    }
  });
}

export type RootState = { schema: SliceState };
export type AppDispatch = typeof store.dispatch;
