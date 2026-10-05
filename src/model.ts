// 领域模型与纯逻辑：显示名称(label)与字段标识(key)分离、标识对照、版本冻结、兼容读回。

export type FieldType = 'text' | 'number' | 'select' | 'date';

export interface FormField {
  uid: string;        // 字段身份，跨版本稳定，不对外暴露
  key: string;        // 字段标识：发布即冻结，改名不动它；真要改必须登记对照
  label: string;      // 显示名称：业务随时改，不影响旧数据
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface LinkRule {
  id: string;
  sourceKey: string;  // 触发字段的标识
  operator: 'equals' | 'notEmpty';
  value: string;
  effect: 'show' | 'require';
  targetKey: string;  // 被联动字段的标识
}

/** 标识对照：oldKey -> newKey，随发布冻结，旧数据按链逐跳翻译到新标识 */
export interface KeyMapping {
  id: string;
  fieldUid: string;
  oldKey: string;
  newKey: string;
  createdAt: string;
}

export interface FormVersion {
  id: string;
  revision: number;
  label: string;
  createdAt: string;   // 这一版发布时间（冻结点）
  frozenAt: string;
  fields: FormField[];
  rules: LinkRule[];
  mappings: KeyMapping[];
}

export interface Snapshot {
  id: string;
  versionId: string;   // 填写当时的版本：历史记录永远按这一版解释
  createdAt: string;
  label: string;
  data: Record<string, string>;
}

/**
 * 编辑草稿。基线 baselineRevision 指向它所依据的已发布版本；
 * pendingMappings 是“改到一半”的对照，随时可断电，重开接着处理。
 */
export interface Draft {
  id: string;
  baselineRevision: number;
  fields: FormField[];
  rules: LinkRule[];
  mappings: KeyMapping[];
  pendingMappings: KeyMapping[];
  updatedAt: number;
}

export interface SchemaState {
  revision: number;
  versions: FormVersion[];
  snapshots: Snapshot[];
  drafts: Draft[];
  activeDraftId: string;
}

export type IssueKind =
  | 'duplicate-current'   // 两个字段当前用着同一标识
  | 'duplicate-target'    // 两条对照换到同一个新标识
  | 'target-exists'       // 新标识和已有标识撞车
  | 'pending'             // 还有没做完的对照
  | 'dangling-rule';      // 联动引用了不存在的标识（警告，发布时剔除）

export interface DraftIssue {
  level: 'error' | 'warning';
  kind: IssueKind;
  message: string;
}

// ---------- 基础查询 ----------

export const fieldByKey = (fields: FormField[], key: string) => fields.find((f) => f.key === key);
export const fieldByUid = (fields: FormField[], uid: string) => fields.find((f) => f.uid === uid);
export const labelOf = (fields: FormField[], key: string) => fieldByKey(fields, key)?.label ?? key;

export function ruleExists(rules: LinkRule[], key: string) {
  return rules.some((r) => r.sourceKey === key || r.targetKey === key);
}

/** 该字段登记对照后被自动重算的联动（引用源/目标从旧标识改到新标识） */
export function affectedRuleIds(rules: LinkRule[], oldKey: string, newKey: string) {
  return rules.filter((r) => r.sourceKey === oldKey || r.targetKey === oldKey)
    .map((r) => ({ id: r.id, newSource: r.sourceKey === oldKey ? newKey : r.sourceKey, newTarget: r.targetKey === oldKey ? newKey : r.targetKey }));
}

// ---------- 发布前校验：撞车必须停下并指出是哪几条 ----------

function indexLabel(fields: FormField[], index: number) {
  return `第 ${index + 1} 条字段「${fields[index].label}」`;
}

export function validateDraft(draft: Draft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const { fields, rules, mappings, pendingMappings } = draft;

  // 1) 当前字段标识两两撞车（含已登记对照、改完标识的字段）
  const byKey = new Map<string, number[]>();
  fields.forEach((f, i) => {
    const list = byKey.get(f.key) ?? [];
    list.push(i);
    byKey.set(f.key, list);
  });
  for (const [key, indexes] of byKey) {
    if (indexes.length > 1) {
      issues.push({
        level: 'error',
        kind: 'duplicate-current',
        message: `标识 "${key}" 被多个字段同时使用：${indexes.map((i) => indexLabel(fields, i)).join('、')}。`,
      });
    }
  }

  // 2) 待处理对照的新标识和已有标识撞车（此时字段还没真正改键）
  // 3) 两条待处理对照换到同一个新标识
  const effectiveKeys = new Map(fields.map((f) => [f.key, f]));
  const pendingByTarget = new Map<string, KeyMapping[]>();
  for (const p of pendingMappings) {
    const owner = fieldByUid(fields, p.fieldUid);
    const blocker = [...effectiveKeys.values()].find((f) => f.key === p.newKey && f.uid !== p.fieldUid);
    if (blocker) {
      issues.push({
        level: 'error',
        kind: 'target-exists',
        message: `对照 ${p.id}：字段「${owner?.label ?? p.fieldUid}」拟改用的新标识 "${p.newKey}" 与已有字段「${blocker.label}」的标识撞车。`,
      });
    }
    const list = pendingByTarget.get(p.newKey) ?? [];
    list.push(p);
    pendingByTarget.set(p.newKey, list);
  }
  for (const [newKey, list] of pendingByTarget) {
    if (list.length > 1) {
      issues.push({
        level: 'error',
        kind: 'duplicate-target',
        message: `${list.map((p) => `${p.id}（「${fieldByUid(fields, p.fieldUid)?.label ?? p.fieldUid}」: ${p.oldKey} → ${newKey}）`).join(' 与 ')} 换到了同一个标识，发布必须停下。`,
      });
    }
  }

  // 4) 没做完的对照：不许发布，但保留下来可继续处理
  if (pendingMappings.length > 0) {
    issues.push({
      level: 'error',
      kind: 'pending',
      message: `还有 ${pendingMappings.length} 条没做完的标识对照：${pendingMappings.map((p) => `${p.id}（${p.oldKey} → ${p.newKey}）`).join('、')}。完成登记或取消后才能发布，草稿已保留。`,
    });
  }

  // 5) 联动引用了本版不存在的标识：警告，发布时剔除这几条
  for (const rule of rules) {
    const missing = [
      !effectiveKeys.has(rule.sourceKey) ? `源标识 "${rule.sourceKey}"` : '',
      !effectiveKeys.has(rule.targetKey) ? `目标标识 "${rule.targetKey}"` : '',
    ].filter(Boolean);
    if (missing.length) {
      issues.push({
        level: 'warning',
        kind: 'dangling-rule',
        message: `联动 ${rule.id} 引用的${missing.join('、')}在本版字段中不存在（字段可能已删除），发布时将自动剔除该联动。`,
      });
    }
  }

  void mappings;
  return issues;
}

export function blockingErrors(draft: Draft) {
  return validateDraft(draft).filter((i) => i.level === 'error');
}

/** 完成一条待处理对照前的即时校验（发布时还会再兜底一次） */
export function commitMappingError(draft: Draft, pending: KeyMapping): string | null {
  const newKey = pending.newKey.trim();
  if (!newKey) return '新标识不能为空。';
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(newKey)) return '标识需以字母开头，只能包含字母、数字和下划线。';
  const owner = fieldByUid(draft.fields, pending.fieldUid);
  const clashField = draft.fields.find((f) => f.uid !== pending.fieldUid && f.key === newKey);
  if (clashField) return `新标识 "${newKey}" 与已有字段「${clashField.label}」的标识撞车。`;
  const clashPending = draft.pendingMappings.find((p) => p.id !== pending.id && p.newKey === newKey);
  if (clashPending) return `新标识 "${newKey}" 与另一条没做完的对照 ${clashPending.id} 重复。`;
  if (owner && owner.key === newKey) return '新标识与当前标识相同，无需对照。';
  return null;
}

// ---------- 标识对照链：旧数据按旧标识逐跳兼容读回 ----------

interface MappingLike { oldKey: string; newKey: string }

/** 从 fromRevision 填写的记录，沿各版本冻结的对照翻译到 toRevision（或草稿） */
export function buildChain(
  versions: FormVersion[],
  fromRevision: number,
  toRevision: number,
  extra: MappingLike[] = [],
): MappingLike[] {
  const frozen = versions
    .filter((v) => v.revision > fromRevision && v.revision <= toRevision)
    .sort((a, b) => a.revision - b.revision)
    .flatMap((v) => v.mappings.map((m) => ({ oldKey: m.oldKey, newKey: m.newKey })));
  return [...frozen, ...extra];
}

export function translateKey(key: string, chain: MappingLike[]): string {
  let cur = key;
  for (const m of chain) {
    if (m.oldKey === cur) cur = m.newKey;
  }
  return cur;
}

// ---------- 旧数据迁移模拟 ----------

export interface MigrationRow {
  oldKey: string;
  newKey: string;
  value: string;
  status: 'ok' | 'renamed' | 'dropped';
  targetLabel?: string;
}

export interface MigrationReport {
  rows: MigrationRow[];
  missingRequired: FormField[];
}

export function migrateData(
  data: Record<string, string>,
  targetFields: FormField[],
  chain: MappingLike[],
): MigrationReport {
  const usedKeys = new Set<string>();
  const rows: MigrationRow[] = Object.entries(data).map(([oldKey, value]) => {
    const newKey = translateKey(oldKey, chain);
    usedKeys.add(newKey);
    const target = fieldByKey(targetFields, newKey);
    return {
      oldKey,
      newKey,
      value,
      status: !target ? 'dropped' : newKey === oldKey ? 'ok' : 'renamed',
      targetLabel: target?.label,
    };
  });
  const missingRequired = targetFields.filter((f) => f.required && !usedKeys.has(f.key));
  return { rows, missingRequired };
}

/** 历史记录按填写当时的版本解释：只取那一版冻结的名称与标识 */
export function explainSnapshot(snapshot: Snapshot, versions: FormVersion[]) {
  const version = versions.find((v) => v.id === snapshot.versionId);
  const fields = version?.fields ?? [];
  return {
    version,
    entries: Object.entries(snapshot.data).map(([key, value]) => ({
      key,
      value,
      label: fieldByKey(fields, key)?.label ?? `（已失效标识 ${key}）`,
    })),
  };
}

// ---------- 草稿与基线的差异 ----------

export interface DraftDiff {
  added: FormField[];
  removed: FormField[];
  renamed: Array<{ field: FormField; oldLabel: string }>;
  rekeyed: Array<{ field: FormField; oldKey: string; newKey: string }>;
  reordered: boolean;
  rulesAdded: LinkRule[];
  rulesRemoved: LinkRule[];
}

export function diffDraft(baseline: FormVersion | undefined, draft: Draft): DraftDiff {
  const base = baseline?.fields ?? [];
  const added = draft.fields.filter((f) => !fieldByUid(base, f.uid));
  const removed = base.filter((f) => !fieldByUid(draft.fields, f.uid));
  const renamed: DraftDiff['renamed'] = [];
  const rekeyed: DraftDiff['rekeyed'] = [];
  for (const field of draft.fields) {
    const old = fieldByUid(base, field.uid);
    if (!old) continue;
    if (old.label !== field.label) renamed.push({ field, oldLabel: old.label });
    const mapping = draft.mappings.filter((m) => m.fieldUid === field.uid).at(-1);
    if (mapping && mapping.oldKey !== field.key) rekeyed.push({ field, oldKey: mapping.oldKey, newKey: field.key });
    else if (old.key !== field.key) rekeyed.push({ field, oldKey: old.key, newKey: field.key });
  }
  const reordered = base.length === draft.fields.length && added.length === 0 && removed.length === 0 &&
    base.some((f, i) => draft.fields[i]?.uid !== f.uid);
  const baseRuleIds = new Set((baseline?.rules ?? []).map((r) => r.id));
  const draftRuleIds = new Set(draft.rules.map((r) => r.id));
  return {
    added,
    removed,
    renamed,
    rekeyed,
    reordered,
    rulesAdded: draft.rules.filter((r) => !baseRuleIds.has(r.id)),
    rulesRemoved: (baseline?.rules ?? []).filter((r) => !draftRuleIds.has(r.id)),
  };
}

// ---------- 基线变化后的三方合并：保住草稿 ----------

/**
 * 以最新版本为新基线合并草稿：
 * 共同字段以草稿改动为准；最新版本带来、草稿没碰过的内容并入；草稿新增的追加。
 */
export function rebaseDraft(draft: Draft, latest: FormVersion): Draft {
  const fields: FormField[] = structuredClone(latest.fields);
  for (const f of draft.fields) {
    const idx = fields.findIndex((item) => item.uid === f.uid);
    if (idx >= 0) fields[idx] = structuredClone(f);
    else fields.push(structuredClone(f));
  }

  const latestRuleIds = new Set(latest.rules.map((r) => r.id));
  const rules: LinkRule[] = [
    ...latest.rules.filter((r) => draft.rules.some((d) => d.id === r.id)),
    ...draft.rules.filter((r) => !latestRuleIds.has(r.id)).map((r) => structuredClone(r)),
  ];

  const aliveUids = new Set(fields.map((f) => f.uid));
  const mappings = draft.mappings.filter((m) => aliveUids.has(m.fieldUid));
  const pendingMappings = draft.pendingMappings.filter((m) => aliveUids.has(m.fieldUid));

  return {
    ...draft,
    baselineRevision: latest.revision,
    fields,
    rules,
    mappings,
    pendingMappings,
    updatedAt: Date.now(),
  };
}

/** 跨标签页状态合并：已发布历史以 revision 高的为准，草稿按 updatedAt 各自保留 */
export function mergeStates(local: SchemaState, remote: SchemaState): SchemaState {
  const remoteIsNewer = remote.revision > local.revision;
  const base = remoteIsNewer ? remote : local;
  const drafts = new Map<string, Draft>();
  for (const d of [...local.drafts, ...remote.drafts]) {
    const existing = drafts.get(d.id);
    if (!existing || d.updatedAt > existing.updatedAt) drafts.set(d.id, d);
  }
  const snapshots = new Map<string, Snapshot>();
  for (const s of [...local.snapshots, ...remote.snapshots]) snapshots.set(s.id, s);
  return {
    revision: base.revision,
    versions: base.versions,
    snapshots: [...snapshots.values()],
    drafts: [...drafts.values()],
    activeDraftId: local.activeDraftId,
  };
}

export function makeField(prefix: string): FormField {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    uid: `f-${prefix}-${suffix}`,
    key: `${prefix}_${suffix}`,
    label: '新字段',
    type: 'text',
    required: false,
  };
}
