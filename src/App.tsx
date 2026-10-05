import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert, AppBar, Box, Button, Card, CardContent, Checkbox, Chip, Container, Dialog, DialogActions, DialogContent,
  DialogTitle, Divider, FormControl, FormControlLabel, Grid, IconButton, InputLabel, MenuItem, Select, Stack,
  Tab, Tabs, TextField, Toolbar, Typography
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  addField, addRule, changeFieldKey, dismissConflict, dismissPublishIssues, publishVersion, rebaseDraft,
  removeField, removeRule, reorderFields, resolveRecord, revertMapping, selectPreview, simulateRemotePublish,
  updateField, useSchemaHistoryQuery,
  type FieldType, type FormField, type FormVersion, type RootState
} from './store';

const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;

const fieldTypeLabel: Record<FieldType, string> = { text: '文本', number: '数字', select: '下拉', date: '日期' };

function SortableFieldRow({ field, isDraft, onEdit, onChangeKey, onRemove }: {
  field: FormField;
  isDraft: boolean;
  onEdit: () => void;
  onChangeKey: () => void;
  onRemove: () => void;
}) {
  const sortable = useSortable({ id: field.id });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" sx={{ mb: 1, transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
      <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: '12px !important', gap: 1 }}>
        <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
          <Typography fontWeight={700}>{field.label}</Typography>
          <Chip size="small" variant="outlined" label={`标识 ${field.key}`} />
          <Typography variant="caption" color="text.secondary">{fieldTypeLabel[field.type]} · {field.required ? '必填' : '选填'}</Typography>
        </Stack>
        {isDraft && (
          <Stack direction="row" gap={0.5} alignItems="center">
            <Button size="small" {...sortable.attributes} {...sortable.listeners}>拖拽</Button>
            <Button size="small" onClick={onEdit}>编辑</Button>
            <Button size="small" color="secondary" onClick={onChangeKey}>修改标识</Button>
            <IconButton size="small" color="error" onClick={onRemove} title="删除字段">✕</IconButton>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

function FieldEditDialog({ field, onClose }: { field: FormField | null; onClose: () => void }) {
  const dispatch = useDispatch();
  const [label, setLabel] = useState(field?.label ?? '');
  const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const [required, setRequired] = useState(field?.required ?? false);
  const [options, setOptions] = useState((field?.options ?? []).join('、'));
  if (!field) return null;
  function save() {
    if (!field) return;
    dispatch(updateField({ id: field.id, changes: { label: label.trim() || field.label, type, required, options: type === 'select' ? options.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : undefined } }));
    onClose();
  }
  return (
    <Dialog open={Boolean(field)} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>编辑字段（只改显示名称，标识不变）</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <TextField label="显示名称" value={label} onChange={(e) => setLabel(e.target.value)} size="small" />
          <FormControl size="small" fullWidth><InputLabel>类型</InputLabel><Select label="类型" value={type} onChange={(e) => setType(e.target.value as FieldType)}>{Object.entries(fieldTypeLabel).map(([value, text]) => <MenuItem key={value} value={value}>{text}</MenuItem>)}</Select></FormControl>
          <FormControlLabel control={<Checkbox checked={required} onChange={(e) => setRequired(e.target.checked)} />} label="必填" />
          {type === 'select' && <TextField label="选项（用顿号或逗号分隔）" value={options} onChange={(e) => setOptions(e.target.value)} size="small" />}
          <Alert severity="info" sx={{ py: 0 }}>字段标识 <b>{field.key}</b> 保持不变；若要更换标识，请关闭后点「修改标识」，会登记一条对照。</Alert>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>取消</Button><Button variant="contained" onClick={save}>保存名称</Button></DialogActions>
    </Dialog>
  );
}

function KeyChangeDialog({ field, existingKeys, onClose }: { field: FormField | null; existingKeys: string[]; onClose: () => void }) {
  const dispatch = useDispatch();
  const [next, setNext] = useState(field?.key ?? '');
  if (!field) return null;
  const trimmed = next.trim();
  const formatOk = KEY_PATTERN.test(trimmed);
  const changed = trimmed !== field.key;
  const collides = existingKeys.includes(trimmed);
  const canSubmit = formatOk && changed;
  function submit() {
    if (!field || !canSubmit) return;
    dispatch(changeFieldKey({ fieldId: field.id, newKey: trimmed }));
    onClose();
  }
  return (
    <Dialog open={Boolean(field)} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>修改字段标识（登记对照）</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <Alert severity="warning" sx={{ py: 0 }}>
            旧数据按旧标识 <b>{field.key}</b> 存储。更换标识将登记一条对照 <b>{field.key} → {trimmed || '…'}</b>，发布时冻结；引用它的联动提示会同步重算。
          </Alert>
          <TextField label="新标识" value={next} onChange={(e) => setNext(e.target.value)} size="small" helperText="小写字母开头，仅含字母、数字、下划线" error={changed && !formatOk} />
          {changed && !formatOk && <Alert severity="error" sx={{ py: 0 }}>标识格式不合法：需小写字母开头，仅含字母、数字、下划线。</Alert>}
          {changed && formatOk && collides && <Alert severity="warning" sx={{ py: 0 }}>该标识已被其他字段使用，发布时会被拦下并指出具体字段。</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>取消</Button><Button variant="contained" color="secondary" disabled={!canSubmit} onClick={submit}>登记对照并更换</Button></DialogActions>
    </Dialog>
  );
}

function MappingPanel({ mappings, isDraft }: { mappings: FormVersion['mappings']; isDraft: boolean }) {
  const dispatch = useDispatch();
  if (!mappings.length) return null;
  return (
    <Box mt={2}>
      <Typography variant="subtitle2" gutterBottom>标识对照{isDraft ? '（待发布，发布时冻结）' : '（本版已冻结）'}</Typography>
      <Stack spacing={0.5}>
        {mappings.map((m) => (
          <Alert key={m.id} severity={m.status === 'pending' ? 'warning' : 'success'} sx={{ py: 0.5 }}
            action={isDraft && m.status === 'pending' ? <Button size="small" color="inherit" onClick={() => dispatch(revertMapping({ mappingId: m.id }))}>撤销</Button> : undefined}>
            <b>{m.from}</b> → <b>{m.to}</b> {m.status === 'pending' ? '· 待发布' : '· 已冻结'}
          </Alert>
        ))}
      </Stack>
    </Box>
  );
}

function RuleEditor({ fields }: { fields: FormField[] }) {
  const dispatch = useDispatch();
  const [fieldId, setFieldId] = useState(fields[0]?.key ?? '');
  const [operator, setOperator] = useState<'equals' | 'notEmpty'>('equals');
  const [value, setValue] = useState('');
  const [effect, setEffect] = useState<'show' | 'require'>('require');
  const [targetId, setTargetId] = useState(fields.at(-1)?.key ?? '');
  useEffect(() => { if (!fields.some((f) => f.key === fieldId)) setFieldId(fields[0]?.key ?? ''); if (!fields.some((f) => f.key === targetId)) setTargetId(fields.at(-1)?.key ?? ''); }, [fields, fieldId, targetId]);
  const canAdd = fieldId && targetId && (operator === 'notEmpty' || value.trim());
  return (
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" mt={1}>
      <Typography variant="body2">当</Typography>
      <Select size="small" value={fieldId} onChange={(e) => setFieldId(e.target.value)} sx={{ minWidth: 120 }}>{fields.map((f) => <MenuItem key={f.key} value={f.key}>{f.label}</MenuItem>)}</Select>
      <Select size="small" value={operator} onChange={(e) => setOperator(e.target.value as 'equals' | 'notEmpty')}>{[{ v: 'equals', t: '等于' }, { v: 'notEmpty', t: '非空' }].map((o) => <MenuItem key={o.v} value={o.v}>{o.t}</MenuItem>)}</Select>
      {operator === 'equals' && <TextField size="small" label="值" value={value} onChange={(e) => setValue(e.target.value)} sx={{ width: 90 }} />}
      <Typography variant="body2">时，则</Typography>
      <Select size="small" value={effect} onChange={(e) => setEffect(e.target.value as 'show' | 'require')}>{[{ v: 'require', t: '必填' }, { v: 'show', t: '显示' }].map((o) => <MenuItem key={o.v} value={o.v}>{o.t}</MenuItem>)}</Select>
      <Select size="small" value={targetId} onChange={(e) => setTargetId(e.target.value)} sx={{ minWidth: 120 }}>{fields.map((f) => <MenuItem key={f.key} value={f.key}>{f.label}</MenuItem>)}</Select>
      <Button size="small" variant="outlined" disabled={!canAdd} onClick={() => dispatch(addRule({ fieldId, operator, value, effect, targetId }))}>添加联动</Button>
    </Stack>
  );
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const { draft } = state;
  const latestVersion = state.versions.find((v) => v.id === state.latestVersionId) ?? state.versions[state.versions.length - 1];
  const active: FormVersion = state.previewVersionId === 'draft'
    ? { id: 'draft', label: '当前草稿', createdAt: '', fields: draft.fields, rules: draft.rules, mappings: draft.mappings }
    : state.versions.find((v) => v.id === state.previewVersionId) ?? latestVersion;
  const isDraft = state.previewVersionId === 'draft';
  const sensors = useSensors(useSensor(PointerSensor));
  const { data: history = [] } = useSchemaHistoryQuery(active.id);

  const [tab, setTab] = useState(0);
  const [editingField, setEditingField] = useState<FormField | null>(null);
  const [keyChangingField, setKeyChangingField] = useState<FormField | null>(null);
  const [runtimeResult, setRuntimeResult] = useState<Record<string, unknown> | null>(null);
  const [migrationNote, setMigrationNote] = useState<string | null>(null);

  const runtimeSchema = useMemo(() => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const f of latestVersion.fields) {
      if (f.type === 'number') shape[f.key] = f.required ? z.coerce.number().positive('金额必须大于0') : z.coerce.number().optional();
      else shape[f.key] = f.required ? z.string().min(1, '请填写') : z.string().optional();
    }
    return z.object(shape);
  }, [latestVersion]);
  const { register, handleSubmit, reset, formState: { errors } } = useForm({ resolver: zodResolver(runtimeSchema) });
  useEffect(() => {
    const defaults: Record<string, unknown> = {};
    for (const f of latestVersion.fields) defaults[f.key] = f.type === 'number' ? 0 : '';
    reset(defaults);
  }, [latestVersion, reset]);

  function dragEnd(event: DragEndEvent) { if (event.over && event.active.id !== event.over.id) dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) })); }
  function simulate(snapshotId: string) {
    const snapshot = state.snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) return;
    const { resolved, changes } = resolveRecord(snapshot.data, state.versions.find((v) => v.id === snapshot.versionId) ?? state.versions[0], latestVersion, state.versions);
    const missing = latestVersion.fields.filter((f) => f.required && !resolved[f.key]).map((f) => f.label);
    const mapped = changes.length ? `；兼容读回 ${changes.length} 条标识对照（${changes.map((c) => `${c.from}→${c.to}`).join('、')}）` : '';
    setMigrationNote(missing.length ? `旧数据缺少新版本必填字段：${missing.join('、')}${mapped}。迁移时需补充或用默认值。` : `旧数据可按当前版本标识读回${mapped}。`);
  }

  const baseVersion = state.versions.find((v) => v.id === draft.baselineVersionId) ?? state.versions[0];
  const pendingCount = draft.mappings.filter((m) => m.status === 'pending').length;

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary"><Toolbar><Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
        {isDraft && <Button color="inherit" onClick={() => dispatch(simulateRemotePublish())} title="模拟另一个标签页抢先发布">另一标签页已发布</Button>}
        <Button color="inherit" onClick={() => dispatch(publishVersion())}>{t('publish')}</Button>
      </Toolbar></AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card><CardContent>
              {state.remoteChanged && <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => dispatch(rebaseDraft())}>重新比对</Button>}>另一标签页已发布新版本（最新 {state.latestVersionId}）。本标签页草稿基线为 {draft.baselineVersionId}，发布前请重新比对，草稿内容已保留。</Alert>}
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2} flexWrap="wrap" gap={1}>
                <div><Typography variant="h6">字段编排</Typography><Typography variant="body2" color="text.secondary">显示名称可随意改；字段标识是存储键，发布即冻结，换标识须登记对照。</Typography></div>
                <Stack direction="row" gap={1} alignItems="center">
                  {isDraft && pendingCount > 0 && <Chip color="warning" label={`${pendingCount} 条对照待发布`} />}
                  {!isDraft && <Button size="small" onClick={() => dispatch(selectPreview('draft'))}>返回草稿</Button>}
                  <Button variant="contained" onClick={() => dispatch(addField())} disabled={!isDraft}>添加字段</Button>
                </Stack>
              </Stack>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={active.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}><Stack>{active.fields.map((field) => <SortableFieldRow key={field.id} field={field} isDraft={isDraft} onEdit={() => setEditingField(field)} onChangeKey={() => setKeyChangingField(field)} onRemove={() => dispatch(removeField({ id: field.id }))} />)}</Stack></SortableContext></DndContext>
              <MappingPanel mappings={active.mappings} isDraft={isDraft} />
              <Divider sx={{ my: 3 }} />
              <Typography variant="h6" mb={1}>联动规则{isDraft ? '' : '（历史版本只读）'}</Typography>
              {active.rules.length === 0 && <Typography variant="body2" color="text.secondary">暂无联动规则。</Typography>}
              {active.rules.map((rule) => {
                const labelOf = (key: string) => active.fields.find((f) => f.key === key)?.label ?? key;
                return <Alert key={rule.id} severity="info" sx={{ mb: 1 }} action={isDraft ? <IconButton size="small" color="error" onClick={() => dispatch(removeRule({ id: rule.id }))}>✕</IconButton> : undefined}>{labelOf(rule.fieldId)} {rule.operator === 'equals' ? `等于 ${rule.value}` : '非空'} 时，{rule.effect === 'require' ? '要求' : '显示'} {labelOf(rule.targetId)}</Alert>;
              })}
              {isDraft && <RuleEditor fields={active.fields} />}
            </CardContent></Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card><CardContent>
              <Tabs value={tab} onChange={(_, value) => setTab(value)}><Tab label="版本差异" /><Tab label={t('simulate')} /><Tab label={t('runtime')} /></Tabs>
              {tab === 0 && <Box mt={2}>
                <Typography fontWeight={700} mb={1}>v1 → {active.label}</Typography>
                <Stack direction="row" gap={1} flexWrap="wrap" mb={1}>{active.fields.filter((f) => !baseVersion.fields.some((b) => b.key === f.key && b.id === f.id)).map((field) => <Chip key={field.id} label={`新增 ${field.label}（${field.key}）`} color="success" variant="outlined" />)}</Stack>
                <MappingPanel mappings={active.mappings} isDraft={isDraft} />
                {baseVersion.fields.filter((b) => !active.fields.some((f) => f.id === b.id)).map((field) => <Chip key={field.id} sx={{ mt: 1 }} label={`删除 ${field.label}（${field.key}）`} color="error" variant="outlined" />)}
                <Alert severity="warning" sx={{ mt: 2 }}>旧版本解释保持冻结；过去提交的数据按填写当时的字段标识存储，不随名称或标识变更而改变。</Alert>
                <Typography mt={2} fontWeight={700}>其他历史版本</Typography>
                {history.map((version) => <Button key={version.id} fullWidth sx={{ justifyContent: 'space-between' }} onClick={() => dispatch(selectPreview(version.id))}>{version.label}<span>{version.createdAt}</span></Button>)}
              </Box>}
              {tab === 1 && <Box mt={2}><Typography fontWeight={700} mb={1}>选择旧数据快照（按旧标识存储）</Typography>{state.snapshots.map((snapshot) => {
                const fromVersion = state.versions.find((v) => v.id === snapshot.versionId) ?? state.versions[0];
                const { resolved, changes } = resolveRecord(snapshot.data, fromVersion, latestVersion, state.versions);
                return (
                  <Card key={snapshot.id} variant="outlined" sx={{ p: 2, mb: 1 }}>
                    <Typography>{snapshot.label} · <Typography component="span" variant="caption" color="text.secondary">{fromVersion.label}</Typography></Typography>
                    <Stack direction="row" gap={0.5} flexWrap="wrap" my={1}>{Object.entries(snapshot.data).map(([k, v]) => <Chip key={k} size="small" variant="outlined" label={`${k}=${v}`} />)}</Stack>
                    {changes.length > 0 && <Stack direction="row" gap={0.5} flexWrap="wrap" mb={1}>{changes.map((c) => <Chip key={c.from} size="small" color="secondary" label={`${c.from} → ${c.to}`} />)}</Stack>}
                    <Typography variant="body2" color="text.secondary" mb={1}>兼容读回：{JSON.stringify(resolved)}</Typography>
                    <Button size="small" onClick={() => simulate(snapshot.id)}>模拟迁移</Button>
                  </Card>
                );
              })}{migrationNote && <Alert severity={migrationNote.includes('缺少') ? 'warning' : 'success'}>{migrationNote}</Alert>}</Box>}
              {tab === 2 && <Box component="form" mt={2} onSubmit={handleSubmit((values) => setRuntimeResult(values))}><Stack spacing={2}>{latestVersion.fields.map((field) => <TextField key={field.id} label={`${field.label}（${field.key}）`} type={field.type === 'number' ? 'number' : 'text'} required={field.required} {...register(field.key, field.type === 'number' ? { valueAsNumber: true } : {})} error={Boolean(errors[field.key])} helperText={errors[field.key]?.message as string} />)}<Button type="submit" variant="contained">按当前版本（{latestVersion.label}）提交</Button></Stack>{runtimeResult && <Alert severity="success" sx={{ mt: 2 }}>运行态数据（按 {latestVersion.label} 标识存储）：{JSON.stringify(runtimeResult)}</Alert>}<Alert severity="info" sx={{ mt: 2 }}>历史记录按填写当时那一版解释，标识冻结不变；以后换名称、换标识都不改写旧结果。</Alert></Box>}
            </CardContent></Card>
          </Grid>
        </Grid>
      </Container>

      <FieldEditDialog key={editingField?.id ?? 'edit'} field={editingField} onClose={() => setEditingField(null)} />
      <KeyChangeDialog key={keyChangingField?.id ?? 'key'} field={keyChangingField} existingKeys={draft.fields.map((f) => f.key)} onClose={() => setKeyChangingField(null)} />

      <Dialog open={Boolean(state.publishIssues)} onClose={() => dispatch(dismissPublishIssues())} fullWidth maxWidth="xs">
        <DialogTitle>发布被拦下：标识冲突</DialogTitle>
        <DialogContent>
          <Alert severity="error" sx={{ mb: 1 }}>以下字段标识存在冲突，请处理后再发布：</Alert>
          <Stack spacing={1}>{state.publishIssues?.map((issue, i) => <Alert key={i} severity="warning" sx={{ py: 0.5 }}>{issue.message}</Alert>)}</Stack>
        </DialogContent>
        <DialogActions><Button variant="contained" onClick={() => dispatch(dismissPublishIssues())}>去处理</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(state.conflict)} onClose={() => dispatch(dismissConflict())} fullWidth maxWidth="xs">
        <DialogTitle>发布冲突：基线已变更</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 1 }}>另一标签页已发布新版本（{state.conflict?.latestVersionId}），本标签页草稿基线为 {state.conflict?.baselineVersionId}。</Alert>
          <Typography variant="body2">草稿内容已保留。请重新比对，确认草稿与新基线的差异后再发布。</Typography>
        </DialogContent>
        <DialogActions><Button onClick={() => dispatch(dismissConflict())}>保留草稿</Button><Button variant="contained" onClick={() => dispatch(rebaseDraft())}>重新比对</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
