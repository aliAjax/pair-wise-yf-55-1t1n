import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type FieldType = 'text' | 'number' | 'select' | 'date';

/**
 * 字段标识（key）与显示名称（label）分开维护：
 * - key 是存储键，发布时冻结，旧记录按填写当时那一版的 key 解释；
 * - label 是显示名称，业务人员可随意改，不影响已存数据。
 */
export interface FormField {
  id: string;       // 行标识（React key，稳定不变）
  key: string;      // 字段标识（存储键，发布即冻结）
  label: string;    // 显示名称（可随时改）
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface LinkRule {
  id: string;
  fieldId: string;   // 引用的字段标识 key
  operator: 'equals' | 'notEmpty';
  value: string;
  effect: 'show' | 'require';
  targetId: string;  // 引用的字段标识 key
}

/** 字段标识变更对照：旧标识 -> 新标识。发布后 status 冻结为 applied。 */
export interface FieldMapping {
  id: string;
  fieldId: string;   // 哪一行字段
  from: string;      // 旧标识
  to: string;        // 新标识
  status: 'pending' | 'applied';
  createdAt: string;
}

export interface FormVersion {
  id: string;
  label: string;
  createdAt: string;
  fields: FormField[];   // 冻结：本版字段标识
  rules: LinkRule[];
  mappings: FieldMapping[]; // 本版冻结的标识对照
}

export interface Snapshot {
  id: string;
  versionId: string;
  label: string;
  data: Record<string, string>; // 按该版本字段标识存储
}

export type PublishIssueType = 'duplicateKey' | 'danglingRule';

export interface PublishIssue {
  type: PublishIssueType;
  message: string;
  keys?: string[];
  fieldLabels?: string[];
  ruleId?: string;
  key?: string;
}

export interface DraftState {
  baselineVersionId: string; // 草稿基于哪一版（并发比对基线）
  fields: FormField[];
  rules: LinkRule[];
  mappings: FieldMapping[];  // 未发布的标识对照（pending，持久化，重开可继续）
}

interface SchemaState {
  versions: FormVersion[];
  draft: DraftState;
  snapshots: Snapshot[];
  latestVersionId: string;   // 发布前沿（另一标签页发布后会推进）
  previewVersionId: string;  // 'draft' 或版本 id
  publishIssues: PublishIssue[] | null;
  conflict: { baselineVersionId: string; latestVersionId: string } | null;
  remoteChanged: boolean;
}

type RootShape = { schema: SchemaState };

/** 深拷贝：状态均为可 JSON 序列化的纯数据，JSON 往返在浏览器与 Node 下都可靠（structuredClone 对 Immer 草稿代理会抛 DataCloneError）。 */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 标识合法格式：小写字母开头，仅字母/数字/下划线（允许 camelCase，与存量标识一致）。 */
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;

function buildInitial(): SchemaState {
  const v1Fields: FormField[] = [
    { id: 'f_name', key: 'name', label: '申请名称', type: 'text', required: true },
    { id: 'f_dept', key: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'f_amount', key: 'amount', label: '申请金额', type: 'number', required: true }
  ];
  const v2Fields: FormField[] = [
    { id: 'f_dept', key: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'f_name', key: 'projectName', label: '申请名称', type: 'text', required: true },
    { id: 'f_budget', key: 'budgetCode', label: '预算科目', type: 'text', required: false },
    { id: 'f_amount', key: 'amount', label: '申请金额', type: 'number', required: true },
    { id: 'f_invoice', key: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
  ];
  const v2Rules: LinkRule[] = [
    { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
    { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
  ];
  const v2Mappings: FieldMapping[] = [
    { id: 'm1', fieldId: 'f_name', from: 'name', to: 'projectName', status: 'applied', createdAt: '2026-09-28' }
  ];
  const versions: FormVersion[] = [
    { id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12', fields: v1Fields, rules: [], mappings: [] },
    { id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28', fields: v2Fields, rules: v2Rules, mappings: v2Mappings }
  ];
  return {
    versions,
    latestVersionId: 'v2',
    previewVersionId: 'draft',
    draft: {
      baselineVersionId: 'v2',
      fields: clone(v2Fields),
      rules: clone(v2Rules),
      mappings: []
    },
    snapshots: [
      { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
      { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } }
    ],
    publishIssues: null,
    conflict: null,
    remoteChanged: false
  };
}

/** 发布前校验：同版标识重复 / 新标识撞车 / 规则引用悬空。 */
export function validateDraft(draft: DraftState): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const byKey = new Map<string, FormField[]>();
  for (const field of draft.fields) {
    const arr = byKey.get(field.key) ?? [];
    arr.push(field);
    byKey.set(field.key, arr);
  }
  for (const [key, fields] of byKey) {
    if (fields.length > 1) {
      issues.push({
        type: 'duplicateKey',
        key,
        keys: [key],
        fieldLabels: fields.map((f) => f.label),
        message: `标识「${key}」被 ${fields.length} 个字段共用：${fields.map((f) => f.label).join('、')}。请调整后再发布。`
      });
    }
  }
  const keys = new Set(draft.fields.map((f) => f.key));
  for (const rule of draft.rules) {
    if (!keys.has(rule.fieldId)) {
      issues.push({ type: 'danglingRule', ruleId: rule.id, key: rule.fieldId, message: `联动规则 ${rule.id} 引用了不存在的字段标识「${rule.fieldId}」。` });
    }
    if (!keys.has(rule.targetId)) {
      issues.push({ type: 'danglingRule', ruleId: rule.id, key: rule.targetId, message: `联动规则 ${rule.id} 引用了不存在的目标标识「${rule.targetId}」。` });
    }
  }
  return issues;
}

/** 沿版本链解析记录：旧标识 -> 新标识（或反向），返回解析后的记录与对照路径。 */
export function resolveRecord(
  record: Record<string, string>,
  fromVersion: FormVersion,
  toVersion: FormVersion,
  versions: FormVersion[]
): { resolved: Record<string, string>; changes: Array<{ from: string; to: string }> } {
  const fromIdx = versions.findIndex((v) => v.id === fromVersion.id);
  const toIdx = versions.findIndex((v) => v.id === toVersion.id);
  const current = { ...record };
  const changes: Array<{ from: string; to: string }> = [];
  if (fromIdx === toIdx) return { resolved: current, changes };
  const forward = toIdx > fromIdx;
  const [lo, hi] = forward ? [fromIdx, toIdx] : [toIdx, fromIdx];
  for (let i = lo + 1; i <= hi; i += 1) {
    for (const mapping of versions[i].mappings) {
      if (mapping.status !== 'applied') continue;
      const fromKey = forward ? mapping.from : mapping.to;
      const toKey = forward ? mapping.to : mapping.from;
      if (fromKey in current) {
        current[toKey] = current[fromKey];
        if (fromKey !== toKey) changes.push({ from: fromKey, to: toKey });
        delete current[fromKey];
      }
    }
  }
  return { resolved: current, changes };
}

const slice = createSlice({
  name: 'schema',
  initialState: buildInitial(),
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      if (state.previewVersionId !== 'draft') return;
      const fields = state.draft.fields;
      const from = fields.findIndex((item) => item.id === action.payload.activeId);
      const to = fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = fields.splice(from, 1);
      fields.splice(to, 0, moved);
    },
    addField(state) {
      if (state.previewVersionId !== 'draft') return;
      state.draft.fields.push({ id: `f_${Date.now()}`, key: `field_${Date.now()}`, label: '新字段', type: 'text', required: false });
    },
    updateField(state, action: PayloadAction<{ id: string; changes: Partial<FormField> }>) {
      if (state.previewVersionId !== 'draft') return;
      const field = state.draft.fields.find((item) => item.id === action.payload.id);
      if (!field) return;
      Object.assign(field, action.payload.changes);
    },
    /**
     * 修改字段标识：登记一条对照（pending），字段 key 切换，
     * 并把引用旧标识的联动提示重算到新标识。
     */
    changeFieldKey(state, action: PayloadAction<{ fieldId: string; newKey: string }>) {
      if (state.previewVersionId !== 'draft') return;
      const { fieldId, newKey } = action.payload;
      const field = state.draft.fields.find((item) => item.id === fieldId);
      if (!field) return;
      const next = newKey.trim();
      if (!KEY_PATTERN.test(next) || next === field.key) return;
      const oldKey = field.key;
      state.draft.mappings.push({
        id: `map_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        fieldId,
        from: oldKey,
        to: next,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
      field.key = next;
      for (const rule of state.draft.rules) {
        if (rule.fieldId === oldKey) rule.fieldId = next;
        if (rule.targetId === oldKey) rule.targetId = next;
      }
    },
    /** 撤销一条未发布的标识对照：还原字段 key，级联删除后续对照，联动提示回退。 */
    revertMapping(state, action: PayloadAction<{ mappingId: string }>) {
      if (state.previewVersionId !== 'draft') return;
      const mapping = state.draft.mappings.find((item) => item.id === action.payload.mappingId);
      if (!mapping) return;
      const removed = new Set<string>();
      const collect = (id: string) => {
        if (removed.has(id)) return;
        const target = state.draft.mappings.find((item) => item.id === id);
        if (!target) return;
        removed.add(id);
        for (const item of state.draft.mappings) if (item.from === target.to) collect(item.id);
      };
      collect(mapping.id);
      const field = state.draft.fields.find((item) => item.id === mapping.fieldId);
      // 还原基准键：基线版本中的键；草稿新增字段则取最早一条对照的 from。
      const baselineMappings = state.draft.mappings
        .filter((item) => item.fieldId === mapping.fieldId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const baselineKey = state.versions.find((v) => v.id === state.draft.baselineVersionId)?.fields.find((f) => f.id === mapping.fieldId)?.key
        ?? baselineMappings[0]?.from
        ?? field?.key;
      state.draft.mappings = state.draft.mappings.filter((item) => !removed.has(item.id));
      if (field) {
        let key = baselineKey ?? field.key;
        for (const item of [...state.draft.mappings].filter((m) => m.fieldId === field.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) key = item.to;
        field.key = key;
      }
      for (const rule of state.draft.rules) {
        if (rule.fieldId === mapping.to) rule.fieldId = mapping.from;
        if (rule.targetId === mapping.to) rule.targetId = mapping.from;
      }
    },
    removeField(state, action: PayloadAction<{ id: string }>) {
      if (state.previewVersionId !== 'draft') return;
      const field = state.draft.fields.find((item) => item.id === action.payload.id);
      if (!field) return;
      state.draft.rules = state.draft.rules.filter((rule) => rule.fieldId !== field.key && rule.targetId !== field.key);
      state.draft.mappings = state.draft.mappings.filter((item) => item.fieldId !== field.id);
      state.draft.fields = state.draft.fields.filter((item) => item.id !== field.id);
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      if (state.previewVersionId !== 'draft') return;
      state.draft.rules.push({ ...action.payload, id: `rule_${Date.now()}` });
    },
    removeRule(state, action: PayloadAction<{ id: string }>) {
      if (state.previewVersionId !== 'draft') return;
      state.draft.rules = state.draft.rules.filter((rule) => rule.id !== action.payload.id);
    },
    /** 发布：先校验，再做并发比对（基线变更则保住草稿、提示重新比对），最后冻结。 */
    publishVersion(state) {
      if (state.previewVersionId !== 'draft') return;
      const issues = validateDraft(state.draft);
      if (issues.length) {
        state.publishIssues = issues;
        return;
      }
      if (state.draft.baselineVersionId !== state.latestVersionId) {
        state.conflict = { baselineVersionId: state.draft.baselineVersionId, latestVersionId: state.latestVersionId };
        return;
      }
      const id = `v${state.versions.length + 1}`;
      const version: FormVersion = {
        id,
        label: `费用申请 ${id}`,
        createdAt: new Date().toISOString().slice(0, 10),
        fields: clone(state.draft.fields),
        rules: clone(state.draft.rules),
        mappings: state.draft.mappings.map((m) => ({ ...m, status: 'applied' as const }))
      };
      state.versions.push(version);
      state.latestVersionId = id;
      state.draft.baselineVersionId = id;
      state.draft.mappings = []; // 对照已冻结进新版本
      state.publishIssues = null;
      state.conflict = null;
    },
    /** 重新比对：基线推进到最新发布前沿，草稿内容保留，重跑校验。 */
    rebaseDraft(state) {
      state.draft.baselineVersionId = state.latestVersionId;
      state.conflict = null;
      state.publishIssues = validateDraft(state.draft);
    },
    /** 模拟另一标签页抢先发布（推进发布前沿），本标签页草稿不动。 */
    simulateRemotePublish(state) {
      const frontier = state.versions.find((v) => v.id === state.latestVersionId) ?? state.versions[state.versions.length - 1];
      const id = `v${state.versions.length + 1}`;
      state.versions.push({
        ...clone(frontier),
        id,
        label: `费用申请 ${id}（另一标签页）`,
        createdAt: new Date().toISOString().slice(0, 10),
        mappings: clone(frontier.mappings)
      });
      state.latestVersionId = id;
      state.remoteChanged = true;
    },
    dismissPublishIssues(state) { state.publishIssues = null; },
    dismissConflict(state) { state.conflict = null; },
    ackRemoteChanged(state) { state.remoteChanged = false; },
    selectPreview(state, action: PayloadAction<string>) { state.previewVersionId = action.payload; },
    replaceState(_state, action: PayloadAction<SchemaState>) { return action.payload; }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (versionId) => {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('yf55-schema-state');
        const state = raw ? (JSON.parse(raw) as SchemaState) : buildInitial();
        return { data: state.versions.filter((item) => item.id !== versionId).slice(-3) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const {
  addField,
  addRule,
  changeFieldKey,
  dismissConflict,
  dismissPublishIssues,
  publishVersion,
  rebaseDraft,
  removeField,
  removeRule,
  reorderFields,
  replaceState,
  revertMapping,
  selectPreview,
  simulateRemotePublish,
  updateField,
  ackRemoteChanged
} = slice.actions;

const STORAGE_KEY = 'yf55-schema-state';

export const store = configureStore({
  reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer },
  middleware: (getDefault) => getDefault().concat(schemaApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Partial<SchemaState>;
      // 仅接受当前数据结构（含 draft/latestVersionId），旧结构或损坏数据直接回退初始状态。
      if (parsed && parsed.draft && parsed.latestVersionId && Array.isArray(parsed.versions)) {
        store.dispatch(replaceState(parsed as SchemaState));
      }
    } catch { /* 忽略损坏的持久化数据 */ }
  }
  store.subscribe(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify((store.getState() as RootShape).schema));
  });
  // 另一标签页发布后，本标签页收到 storage 事件：仅提示基线已变更，草稿保留。
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const incoming = JSON.parse(event.newValue) as SchemaState;
      const current = (store.getState() as RootShape).schema;
      if (incoming.latestVersionId !== current.latestVersionId) store.dispatch(ackRemoteChanged());
    } catch { /* 忽略解析失败 */ }
  });
}

export type RootState = RootShape;
