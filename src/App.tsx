import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert, AppBar, Box, Button, Card, CardContent, Chip, Container, Divider, FormControl,
  Grid, IconButton, InputLabel, MenuItem, Select, Stack, Tab, Tabs, TextField, Toolbar, Tooltip, Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  affectedRuleIds,
  buildChain,
  diffDraft,
  explainSnapshot,
  fieldByKey,
  labelOf,
  migrateData,
  validateDraft,
  type Draft,
  type FormField,
  type FormVersion,
  type LinkRule,
  type Snapshot,
} from './model';
import {
  addField, addRule, beginRenameKey, cancelPendingMapping, clearPublishFeedback, cloneDraft,
  commitPendingMapping, publishVersion, removeRule, reorderFields, selectDraft, submitSnapshot,
  updateField, updatePendingMapping,
} from './store';
import type { RootState } from './store';

// ---------------------------------------------------------------- 字段编排

function KeyEditor({ draft, field }: { draft: Draft; field: FormField }) {
  const dispatch = useDispatch();
  const pending = draft.pendingMappings.find((m) => m.fieldUid === field.uid);
  const [error, setError] = useState<string | null>(null);
  const [recalculated, setRecalculated] = useState<string[]>([]);

  if (pending) {
    const tryCommit = () => {
      const newKey = pending.newKey.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(newKey)) { setError('标识需以字母开头，只能含字母、数字和下划线。'); return; }
      const clashField = draft.fields.find((f) => f.uid !== field.uid && f.key === newKey);
      if (clashField) { setError(`与字段「${clashField.label}」的现有标识撞车。`); return; }
      const clashPending = draft.pendingMappings.find((m) => m.id !== pending.id && m.newKey === newKey);
      if (clashPending) { setError(`与另一条没做完的对照 ${clashPending.id} 重复。`); return; }
      const hits = affectedRuleIds(draft.rules, pending.oldKey, newKey);
      setRecalculated(hits.map((h) => h.id));
      dispatch(commitPendingMapping({ draftId: draft.id, pendingId: pending.id }));
      setError(null);
    };
    return (
      <Box sx={{ mt: 1, p: 1.5, border: '1px dashed', borderColor: 'warning.main', borderRadius: 1, bgcolor: 'warning.50' }}>
        <Typography variant="caption" color="warning.dark" fontWeight={700}>
          没做完的对照 {pending.id}（保存中断后重开仍在此处接着处理）
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center" mt={0.5}>
          <Chip size="small" label={`旧 ${pending.oldKey}`} variant="outlined" />
          <Typography variant="caption">→</Typography>
          <TextField
            size="small" sx={{ width: 200 }} label="新标识" value={pending.newKey}
            onChange={(e) => dispatch(updatePendingMapping({ draftId: draft.id, pendingId: pending.id, newKey: e.target.value }))}
          />
          <Button size="small" variant="contained" color="warning" onClick={tryCommit}>完成对照</Button>
          <Button size="small" onClick={() => dispatch(cancelPendingMapping({ draftId: draft.id, pendingId: pending.id }))}>取消</Button>
        </Stack>
        {error && <Alert severity="error" sx={{ mt: 1, py: 0 }}>{error}</Alert>}
      </Box>
    );
  }

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center">
        <Chip size="small" label={`标识 ${field.key}`} variant="outlined" color="primary" />
        <Tooltip title="改显示名称不影响标识；只有真的要换标识时才登记对照，旧数据按旧标识兼容读回">
          <Button
            size="small" onClick={() => { setRecalculated([]); dispatch(beginRenameKey({ draftId: draft.id, uid: field.uid, newKey: `${field.key}_x` })); }}
          >
            更换标识…
          </Button>
        </Tooltip>
      </Stack>
      {recalculated.length > 0 && (
        <Typography variant="caption" color="success.dark">
          标识已更换，联动 {recalculated.join('、')} 的引用已自动重算。
        </Typography>
      )}
    </Box>
  );
}

function SortableFieldCard({ draft, field }: { draft: Draft; field: FormField }) {
  const dispatch = useDispatch();
  const sortable = useSortable({ id: field.uid });
  const mapping = draft.mappings.filter((m) => m.fieldUid === field.uid).at(-1);
  return (
    <Card
      ref={sortable.setNodeRef} variant="outlined" sx={{ mb: 1, transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
    >
      <CardContent sx={{ py: '12px !important', px: 2 }}>
        <Stack direction="row" spacing={2} alignItems="flex-start">
          <Box {...sortable.attributes} {...sortable.listeners} sx={{ cursor: 'grab', pt: 1, color: 'text.secondary' }}>⋮⋮</Box>
          <Box flexGrow={1}>
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
              <TextField
                size="small" sx={{ width: 220 }} label="显示名称（随时可改）" value={field.label}
                onChange={(e) => dispatch(updateField({ draftId: draft.id, uid: field.uid, patch: { label: e.target.value } }))}
              />
              <FormControl size="small" sx={{ width: 110 }}>
                <InputLabel>类型</InputLabel>
                <Select
                  label="类型" value={field.type}
                  onChange={(e) => dispatch(updateField({ draftId: draft.id, uid: field.uid, patch: { type: e.target.value as FormField['type'] } }))}
                >
                  <MenuItem value="text">文本</MenuItem>
                  <MenuItem value="number">数字</MenuItem>
                  <MenuItem value="select">选项</MenuItem>
                  <MenuItem value="date">日期</MenuItem>
                </Select>
              </FormControl>
              <Button
                size="small" variant={field.required ? 'contained' : 'outlined'}
                onClick={() => dispatch(updateField({ draftId: draft.id, uid: field.uid, patch: { required: !field.required } }))}
              >
                {field.required ? '必填' : '选填'}
              </Button>
            </Stack>
            <Box mt={1}>
              <KeyEditor draft={draft} field={field} />
              {mapping && (
                <Typography variant="caption" color="text.secondary">
                  本版已登记对照：{mapping.oldKey} → {mapping.newKey}（发布后冻结，旧记录按旧标识读回）
                </Typography>
              )}
            </Box>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function ruleText(rule: LinkRule, fields: FormField[]) {
  const cond = rule.operator === 'equals' ? `等于「${rule.value}」` : '非空';
  return `当 ${labelOf(fields, rule.sourceKey)} ${cond} 时，${rule.effect === 'require' ? '要求填写' : '显示'} ${labelOf(fields, rule.targetKey)}`;
}

function RulesPanel({ draft }: { draft: Draft }) {
  const dispatch = useDispatch();
  const [sourceKey, setSourceKey] = useState(draft.fields[0]?.key ?? '');
  const [targetKey, setTargetKey] = useState(draft.fields[1]?.key ?? draft.fields[0]?.key ?? '');
  const [operator, setOperator] = useState<LinkRule['operator']>('notEmpty');
  const [effect, setEffect] = useState<LinkRule['effect']>('show');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!draft.fields.some((f) => f.key === sourceKey)) setSourceKey(draft.fields[0]?.key ?? '');
    if (!draft.fields.some((f) => f.key === targetKey)) setTargetKey(draft.fields[1]?.key ?? draft.fields[0]?.key ?? '');
  }, [draft.fields, sourceKey, targetKey]);

  return (
    <Box>
      <Typography variant="h6" mb={1}>联动规则（按字段标识引用）</Typography>
      {draft.rules.length === 0 && <Typography variant="body2" color="text.secondary">暂无规则。</Typography>}
      {draft.rules.map((rule) => {
        const dangling = !fieldByKey(draft.fields, rule.sourceKey) || !fieldByKey(draft.fields, rule.targetKey);
        return (
          <Alert
            key={rule.id} severity={dangling ? 'warning' : 'info'} sx={{ mb: 1 }}
            action={<IconButton size="small" onClick={() => dispatch(removeRule({ draftId: draft.id, ruleId: rule.id }))}><DeleteOutlineIcon fontSize="small" /></IconButton>}
          >
            {rule.id}：{ruleText(rule, draft.fields)}
            {dangling && '（引用标识已不存在，发布时将剔除）'}
          </Alert>
        );
      })}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} mt={2}>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>触发字段</InputLabel>
          <Select label="触发字段" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            {draft.fields.map((f) => <MenuItem key={f.uid} value={f.key}>{f.label}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 110 }}>
          <InputLabel>条件</InputLabel>
          <Select label="条件" value={operator} onChange={(e) => setOperator(e.target.value as LinkRule['operator'])}>
            <MenuItem value="notEmpty">非空</MenuItem>
            <MenuItem value="equals">等于</MenuItem>
          </Select>
        </FormControl>
        {operator === 'equals' && <TextField size="small" sx={{ width: 130 }} label="比较值" value={value} onChange={(e) => setValue(e.target.value)} />}
        <FormControl size="small" sx={{ minWidth: 110 }}>
          <InputLabel>效果</InputLabel>
          <Select label="效果" value={effect} onChange={(e) => setEffect(e.target.value as LinkRule['effect'])}>
            <MenuItem value="show">显示</MenuItem>
            <MenuItem value="require">要求填写</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>联动字段</InputLabel>
          <Select label="联动字段" value={targetKey} onChange={(e) => setTargetKey(e.target.value)}>
            {draft.fields.map((f) => <MenuItem key={f.uid} value={f.key}>{f.label}</MenuItem>)}
          </Select>
        </FormControl>
        <Button
          variant="outlined"
          onClick={() => dispatch(addRule({ draftId: draft.id, rule: { sourceKey, operator, value: operator === 'equals' ? value : '', effect, targetKey } }))}
        >
          添加联动
        </Button>
      </Stack>
    </Box>
  );
}

function DraftEditor({ draft, baselineVersion, latestRevision }: { draft: Draft; baselineVersion?: FormVersion; latestRevision: number }) {
  const dispatch = useDispatch();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const issues = useMemo(() => validateDraft(draft), [draft]);
  const errors = issues.filter((i) => i.level === 'error');
  const diff = useMemo(() => diffDraft(baselineVersion, draft), [baselineVersion, draft]);
  const stale = latestRevision > draft.baselineRevision;

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderFields({ draftId: draft.id, activeUid: String(event.active.id), overUid: String(event.over.id) }));
    }
  }

  return (
    <Card>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={2}>
          <div>
            <Typography variant="h6">字段编排 · 草稿 {draft.id}</Typography>
            <Typography variant="body2" color="text.secondary">
              基线 v{draft.baselineRevision} · 显示名称随便改，字段标识发布后冻结
            </Typography>
          </div>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={() => dispatch(cloneDraft({ draftId: draft.id }))}>复制并行草稿（模拟另一标签页）</Button>
            <Button variant="contained" onClick={() => dispatch(addField({ draftId: draft.id }))}>添加字段</Button>
          </Stack>
        </Stack>

        {stale && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            基线已经变化（v{draft.baselineRevision} 之后已有 v{latestRevision} 发布，通常是另一个标签页先提交）。这份草稿已保住并并入最新基线，请重新比对后再发布。
          </Alert>
        )}

        {errors.length > 0 && (
          <Alert severity="error" sx={{ mb: 2 }} title="发布将被拦下">
            <Typography fontWeight={700}>发布前必须解决 {errors.length} 个问题：</Typography>
            {errors.map((issue, i) => <div key={i}>• {issue.message}</div>)}
          </Alert>
        )}
        {issues.filter((i) => i.level === 'warning').length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {issues.filter((i) => i.level === 'warning').map((issue, i) => <div key={i}>• {issue.message}</div>)}
          </Alert>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={draft.fields.map((f) => f.uid)} strategy={verticalListSortingStrategy}>
            {draft.fields.map((f) => <SortableFieldCard key={f.uid} draft={draft} field={f} />)}
          </SortableContext>
        </DndContext>

        <Divider sx={{ my: 3 }} />
        <RulesPanel draft={draft} />

        <Divider sx={{ my: 3 }} />
        <Box>
          <Typography variant="h6" mb={1}>本版相对基线的差异</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {diff.added.map((f) => <Chip key={f.uid} size="small" color="success" label={`新增字段「${f.label}」(${f.key})`} variant="outlined" />)}
            {diff.removed.map((f) => <Chip key={f.uid} size="small" color="error" label={`删除字段「${f.label}」(${f.key})`} variant="outlined" />)}
            {diff.renamed.map(({ field: f, oldLabel }) => <Chip key={f.uid} size="small" color="info" label={`仅改名：${oldLabel} → ${f.label}，标识 ${f.key} 不变`} variant="outlined" />)}
            {diff.rekeyed.map(({ field: f, oldKey, newKey }) => <Chip key={f.uid} size="small" color="warning" label={`换标识：${oldKey} → ${newKey}（「${f.label}」）`} variant="outlined" />)}
            {diff.reordered && <Chip size="small" label="顺序调整" variant="outlined" />}
            {diff.rulesAdded.map((r) => <Chip key={r.id} size="small" color="success" label={`新增联动 ${r.id}`} variant="outlined" />)}
            {diff.rulesRemoved.map((r) => <Chip key={r.id} size="small" color="error" label={`删除联动 ${r.id}`} variant="outlined" />)}
            {diff.added.length + diff.removed.length + diff.renamed.length + diff.rekeyed.length + diff.rulesAdded.length + diff.rulesRemoved.length === 0 && !diff.reordered && (
              <Typography variant="body2" color="text.secondary">与基线一致，没有未发布改动。</Typography>
            )}
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- 版本与历史

function VersionsTab({ versions, snapshots }: { versions: FormVersion[]; snapshots: Snapshot[] }) {
  return (
    <Box mt={2}>
      <Typography variant="h6" mb={1}>已发布版本（标识冻结点）</Typography>
      {[...versions].reverse().map((version) => (
        <Card key={version.id} variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography fontWeight={700}>{version.label}</Typography>
              <Chip size="small" label={`发布于 ${version.createdAt}`} />
            </Stack>
            <Typography variant="body2" color="text.secondary" mt={1}>
              字段标识：{version.fields.map((f) => f.key).join('、')}
            </Typography>
            {version.mappings.length > 0 && (
              <Typography variant="body2" color="warning.dark" mt={0.5}>
                本版冻结的标识对照：{version.mappings.map((m) => `${m.oldKey} → ${m.newKey}`).join('；')}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              这一版收到的记录永远按这一版解释；以后再改标识也不改旧结果。
            </Typography>
          </CardContent>
        </Card>
      ))}

      <Divider sx={{ my: 2 }} />
      <Typography variant="h6" mb={1}>历史记录（按填写当时的版本解释）</Typography>
      {snapshots.map((snapshot) => {
        const { version, entries } = explainSnapshot(snapshot, versions);
        return (
          <Card key={snapshot.id} variant="outlined" sx={{ mb: 1, p: 1.5 }}>
            <Stack direction="row" justifyContent="space-between">
              <Typography fontWeight={700}>{snapshot.label}</Typography>
              <Chip size="small" label={`${version?.label ?? '版本缺失'} · ${snapshot.createdAt}`} variant="outlined" />
            </Stack>
            <Typography variant="body2" mt={0.5}>
              {entries.map((e) => `${e.label}[${e.key}]=${e.value || '空'}`).join('　')}
            </Typography>
          </Card>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------- 旧数据兼容读回

function MigrationTab({ draft, versions, snapshots }: { draft: Draft; versions: FormVersion[]; snapshots: Snapshot[] }) {
  const [selectedId, setSelectedId] = useState(snapshots[0]?.id ?? '');
  const snapshot = snapshots.find((s) => s.id === selectedId) ?? snapshots[0];

  const report = useMemo(() => {
    if (!snapshot) return null;
    // 旧记录 → 草稿：沿中间各版本冻结的对照链逐跳翻译，再叠加草稿里已登记未发布的对照
    const from = versions.find((v) => v.id === snapshot.versionId);
    const latest = versions[versions.length - 1];
    if (!from || !latest) return null;
    const chain = buildChain(versions, from.revision, latest.revision, draft.mappings.map((m) => ({ oldKey: m.oldKey, newKey: m.newKey })));
    return { chain, from, report: migrateData(snapshot.data, draft.fields, chain) };
  }, [snapshot, versions, draft.fields, draft.mappings]);

  return (
    <Box mt={2}>
      <Typography variant="h6" mb={1}>选一条旧记录，模拟在当前草稿结构下兼容读回</Typography>
      <FormControl size="small" fullWidth sx={{ mb: 2 }}>
        <InputLabel>旧记录</InputLabel>
        <Select label="旧记录" value={snapshot?.id ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
          {snapshots.map((s) => {
            const v = versions.find((item) => item.id === s.versionId);
            return <MenuItem key={s.id} value={s.id}>{s.label}（{v?.label ?? s.versionId}）</MenuItem>;
          })}
        </Select>
      </FormControl>

      {snapshot && report && (
        <>
          <Alert severity="info" sx={{ mb: 2 }}>
            原始数据按 {report.from.label} 解释：{JSON.stringify(snapshot.data)}
          </Alert>
          <Typography variant="body2" color="text.secondary" mb={1}>
            对照链：{report.chain.length ? report.chain.map((m) => `${m.oldKey}→${m.newKey}`).join('，') : '无（标识一直没变）'}
          </Typography>
          {report.report.rows.map((row) => (
            <Alert key={row.oldKey} severity={row.status === 'dropped' ? 'warning' : row.status === 'renamed' ? 'success' : 'info'} sx={{ mb: 1 }}>
              {row.oldKey} {row.status === 'renamed' && `→ ${row.newKey}`} = {row.value}
              {row.status === 'dropped' && '：目标版本已无此字段，值搁置不丢'}
              {row.targetLabel && `（读入字段「${row.targetLabel}」）`}
            </Alert>
          ))}
          {report.report.missingRequired.length > 0 ? (
            <Alert severity="warning" sx={{ mt: 1 }}>
              迁移后仍缺必填：{report.report.missingRequired.map((f) => `${f.label}(${f.key})`).join('、')}，需补充或给默认值。
            </Alert>
          ) : (
            <Alert severity="success" sx={{ mt: 1 }}>除被删字段外，旧数据可完整兼容读回。</Alert>
          )}
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------- 运行态表单

const runtimeSchema = z.record(z.string(), z.union([z.string(), z.number()]));
type RuntimeValues = Record<string, string | number>;

function RuntimeTab({ version, onSubmitted }: { version: FormVersion; onSubmitted: (label: string, data: Record<string, string>) => void }) {
  const [result, setResult] = useState<Record<string, string> | null>(null);
  const form = useForm<RuntimeValues>({
    resolver: zodResolver(runtimeSchema),
    defaultValues: Object.fromEntries(version.fields.map((f) => [f.key, f.type === 'number' ? 0 : ''])),
  });

  useEffect(() => {
    form.reset(Object.fromEntries(version.fields.map((f) => [f.key, f.type === 'number' ? 0 : ''])));
    setResult(null);
  }, [version.id, form]);

  const values = form.watch();
  const visibleKeys = new Set(version.fields.map((f) => f.key));
  const requiredKeys = new Set(version.fields.filter((f) => f.required).map((f) => f.key));

  // show 联动：触发条件不满足时隐藏
  for (const rule of version.rules.filter((r) => r.effect === 'show')) {
    const v = values[rule.sourceKey];
    const hit = rule.operator === 'notEmpty' ? String(v ?? '').trim() !== '' : String(v ?? '') === rule.value;
    if (!hit) visibleKeys.delete(rule.targetKey);
  }
  // require 联动：满足时动态必填
  for (const rule of version.rules.filter((r) => r.effect === 'require')) {
    const v = values[rule.sourceKey];
    const hit = rule.operator === 'notEmpty' ? String(v ?? '').trim() !== '' : String(v ?? '') === rule.value;
    if (hit) requiredKeys.add(rule.targetKey);
  }

  function submit(raw: RuntimeValues) {
    const data: Record<string, string> = {};
    const missing: Array<{ key: string; label: string }> = [];
    for (const f of version.fields) {
      if (!visibleKeys.has(f.key)) continue;
      const value = String(raw[f.key] ?? '').trim();
      if (requiredKeys.has(f.key) && !value) missing.push({ key: f.key, label: f.label });
      data[f.key] = value;
    }
    if (missing.length) {
      for (const m of missing) form.setError(m.key, { message: `「${m.label}」必填` });
      return;
    }
    setResult(data);
    onSubmitted(`${version.label} 新记录`, data);
  }

  return (
    <Box mt={2}>
      <Alert severity="info" sx={{ mb: 2 }}>
        运行态使用最新发布的 {version.label}（已冻结）。提交的数据以这一版的字段标识存档，将来改名/换标识都按对照兼容。
      </Alert>
      <Box component="form" onSubmit={form.handleSubmit(submit)}>
        <Stack spacing={2}>
          {version.fields.filter((f) => visibleKeys.has(f.key)).map((f) => {
            const err = form.formState.errors[f.key];
            return (
              <TextField
                key={f.uid}
                size="small"
                label={`${f.label}（${f.key}）${requiredKeys.has(f.key) ? ' *' : ''}`}
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                slotProps={f.type === 'date' ? { inputLabel: { shrink: true } } : undefined}
                error={Boolean(err)}
                helperText={err?.message as string | undefined}
                {...form.register(f.key, f.type === 'number' ? { setValueAs: (v) => (v === '' ? '' : Number(v)) } : {})}
              />
            );
          })}
          <Button type="submit" variant="contained">按 {version.label} 提交</Button>
        </Stack>
      </Box>
      {result && <Alert severity="success" sx={{ mt: 2 }}>已存档（标识为准）：{JSON.stringify(result)}</Alert>}
    </Box>
  );
}

// ---------------------------------------------------------------- 根组件

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const [tab, setTab] = useState(0);

  const draft = state.drafts.find((d) => d.id === state.activeDraftId) ?? state.drafts[0];
  const latestVersion = state.versions[state.versions.length - 1];
  const baselineVersion = state.versions.find((v) => v.revision === draft?.baselineRevision);
  const feedback = state.lastPublish;

  if (!draft) return <Container sx={{ py: 6 }}><Typography>没有草稿。</Typography></Container>;

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <FormControl size="small" sx={{ bgcolor: 'background.paper', borderRadius: 1, minWidth: 200, mr: 2 }}>
            <Select value={draft.id} onChange={(e) => dispatch(selectDraft(e.target.value))}>
              {state.drafts.map((d) => (
                <MenuItem key={d.id} value={d.id}>草稿 {d.id}（基线 v{d.baselineRevision}{d.pendingMappings.length ? ` · ${d.pendingMappings.length} 条对照未做完` : ''}）</MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button color="inherit" variant="outlined" onClick={() => { dispatch(publishVersion({ draftId: draft.id })); }}>
            {t('publish')}
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="xl" sx={{ py: 3 }}>
        {feedback?.ok && (
          <Alert
            severity="success" sx={{ mb: 2 }}
            action={<Button color="inherit" size="small" onClick={() => dispatch(clearPublishFeedback())}>知道了</Button>}
          >
            已发布并冻结 {feedback.versionId}：这一版的字段标识不再变化，历史记录照旧版本解释。
            {feedback.issues?.length ? ` 提醒：${feedback.issues.map((i) => i.message).join('；')}` : ''}
          </Alert>
        )}
        {feedback && !feedback.ok && feedback.stale && (
          <Alert
            severity="warning" sx={{ mb: 2 }}
            action={<Button color="inherit" size="small" onClick={() => { setTab(0); dispatch(clearPublishFeedback()); }}>去重新比对</Button>}
          >
            发布已拦下：{feedback.reason}
          </Alert>
        )}
        {feedback && !feedback.ok && !feedback.stale && (
          <Alert
            severity="error" sx={{ mb: 2 }}
            action={<Button color="inherit" size="small" onClick={() => dispatch(clearPublishFeedback())}>知道了</Button>}
          >
            <div>{feedback.reason}</div>
            {feedback.issues?.filter((i) => i.level === 'error').map((i, idx) => <div key={idx}>• {i.message}</div>)}
          </Alert>
        )}

        <Alert severity="info" sx={{ mb: 2 }} variant="outlined">
          并发发布：在两个浏览器标签页打开本页，各自改草稿后先后发布；后提交的会发现基线变了——草稿完整保留并提示重新比对。
          中途断电：没做完的标识对照随草稿持久化，重开页面继续处理。
        </Alert>

        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <DraftEditor draft={draft} baselineVersion={baselineVersion} latestRevision={latestVersion.revision} />
          </Grid>
          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, v) => setTab(v)}>
                  <Tab label="版本与历史" />
                  <Tab label={t('simulate')} />
                  <Tab label={t('runtime')} />
                </Tabs>
                {tab === 0 && <VersionsTab versions={state.versions} snapshots={state.snapshots} />}
                {tab === 1 && <MigrationTab draft={draft} versions={state.versions} snapshots={state.snapshots} />}
                {tab === 2 && (
                  <RuntimeTab
                    version={latestVersion}
                    onSubmitted={(label, data) => dispatch(submitSnapshot({ versionId: latestVersion.id, label, data }))}
                  />
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
