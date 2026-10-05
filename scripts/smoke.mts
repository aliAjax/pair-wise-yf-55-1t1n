import assert from 'node:assert';
import {
  buildChain, translateKey, validateDraft, migrateData, rebaseDraft, makeField,
  type Draft, type FormVersion,
} from '../src/model';

let passed = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); passed++; console.log('✓', name); };

// --- 版本准备：v1 有 name/dept/amount；v2 把 amount 重命名为 totalAmount ---
const v1: FormVersion = {
  id: 'v1', revision: 1, label: 'v1', createdAt: '', frozenAt: '',
  fields: [
    { uid: 'u-name', key: 'name', label: '名称', type: 'text', required: true },
    { uid: 'u-amt', key: 'amount', label: '金额', type: 'number', required: true },
  ],
  rules: [], mappings: [],
};
const v2: FormVersion = {
  id: 'v2', revision: 2, label: 'v2', createdAt: '', frozenAt: '',
  fields: [
    { uid: 'u-name', key: 'name', label: '申请名称', type: 'text', required: true },
    { uid: 'u-amt', key: 'totalAmount', label: '申请金额', type: 'number', required: true },
  ],
  rules: [{ id: 'r1', sourceKey: 'totalAmount', operator: 'notEmpty', value: '', effect: 'show', targetKey: 'name' }],
  mappings: [{ id: 'm1', fieldUid: 'u-amt', oldKey: 'amount', newKey: 'totalAmount', createdAt: '' }],
};

// 1) 旧数据按旧标识兼容读回：v1 记录的 amount 经冻结对照链翻译成 totalAmount
const chain = buildChain([v1, v2], 1, 2);
assert.deepStrictEqual(chain.map((m) => [m.oldKey, m.newKey]), [['amount', 'totalAmount']]);
ok('对照链只取区间内冻结的版本', true);
assert.strictEqual(translateKey('amount', chain), 'totalAmount');
assert.strictEqual(translateKey('name', chain), 'name');
ok('旧记录 amount 按旧标识逐跳读回 totalAmount，name 不变', true);

const migrated = migrateData({ name: '培训', amount: '9' }, v2.fields, chain);
assert.strictEqual(migrated.rows.find((r) => r.oldKey === 'amount')?.status, 'renamed');
assert.strictEqual(migrated.missingRequired.length, 0);
ok('迁移模拟：改名字段命中、无缺失必填', true);

// 2) 链式换标识：v3 再把 totalAmount → money，旧 amount 应逐跳到 money
const v3: FormVersion = {
  id: 'v3', revision: 3, label: 'v3', createdAt: '', frozenAt: '',
  fields: [
    { uid: 'u-name', key: 'name', label: '申请名称', type: 'text', required: true },
    { uid: 'u-amt', key: 'money', label: '金额(元)', type: 'number', required: true },
  ],
  rules: [],
  mappings: [{ id: 'm2', fieldUid: 'u-amt', oldKey: 'totalAmount', newKey: 'money', createdAt: '' }],
};
const chain2 = buildChain([v1, v2, v3], 1, 3);
assert.strictEqual(translateKey('amount', chain2), 'money');
ok('跨两版的标识链 amount → totalAmount → money 逐跳翻译', true);

// 3) 撞车：两个字段当前用同一标识 → 发布停下并指出哪几条
const badDraft: Draft = {
  id: 'd', baselineRevision: 3, fields: [
    { uid: 'a', key: 'k1', label: '甲', type: 'text', required: false },
    { uid: 'b', key: 'k1', label: '乙', type: 'text', required: false },
  ], rules: [], mappings: [], pendingMappings: [], updatedAt: 0,
};
let issues = validateDraft(badDraft);
assert.strictEqual(issues.some((i) => i.kind === 'duplicate-current' && i.message.includes('甲') && i.message.includes('乙')), true);
ok('同版两个字段同一标识：错误信息点到第几条字段', true);

// 4) 新标识与已有标识撞车（待处理对照还没 commit）
const clashDraft: Draft = {
  id: 'd', baselineRevision: 3, fields: [
    { uid: 'a', key: 'k1', label: '甲', type: 'text', required: false },
    { uid: 'b', key: 'k2', label: '乙', type: 'text', required: false },
  ], rules: [], mappings: [],
  pendingMappings: [{ id: 'p1', fieldUid: 'b', oldKey: 'k2', newKey: 'k1', createdAt: '' }],
  updatedAt: 0,
};
issues = validateDraft(clashDraft);
assert.strictEqual(issues.some((i) => i.kind === 'target-exists'), true);
assert.strictEqual(issues.some((i) => i.kind === 'pending'), true);
ok('新标识撞已有标识报错；没做完的对照也阻止发布', true);

// 5) 两条对照换到同一个新标识
const dupTarget: Draft = {
  id: 'd', baselineRevision: 3, fields: [
    { uid: 'a', key: 'k1', label: '甲', type: 'text', required: false },
    { uid: 'b', key: 'k2', label: '乙', type: 'text', required: false },
  ], rules: [], mappings: [],
  pendingMappings: [
    { id: 'p1', fieldUid: 'a', oldKey: 'k1', newKey: 'kx', createdAt: '' },
    { id: 'p2', fieldUid: 'b', oldKey: 'k2', newKey: 'kx', createdAt: '' },
  ],
  updatedAt: 0,
};
issues = validateDraft(dupTarget);
assert.strictEqual(issues.some((i) => i.kind === 'duplicate-target' && i.message.includes('p1') && i.message.includes('p2')), true);
ok('两条对照换到同一标识：错误信息点出 p1 与 p2', true);

// 6) 并发发布 rebase：草稿改名 name→title，v3 同时新增字段 note；合并后两者都在
const draftAtV2: Draft = {
  id: 'd', baselineRevision: 2,
  fields: [
    { uid: 'u-name', key: 'title', label: '标题', type: 'text', required: true },
    { uid: 'u-amt', key: 'totalAmount', label: '申请金额', type: 'number', required: true },
  ],
  rules: [],
  mappings: [{ id: 'mx', fieldUid: 'u-name', oldKey: 'name', newKey: 'title', createdAt: '' }],
  pendingMappings: [],
  updatedAt: 1,
};
const v3b: FormVersion = {
  id: 'v3', revision: 3, label: 'v3', createdAt: '', frozenAt: '',
  fields: [
    { uid: 'u-name', key: 'name', label: '申请名称', type: 'text', required: true },
    { uid: 'u-amt', key: 'totalAmount', label: '申请金额', type: 'number', required: true },
    { uid: 'u-note', key: 'note', label: '备注', type: 'text', required: false },
  ],
  rules: [], mappings: [],
};
const rebased = rebaseDraft(draftAtV2, v3b);
assert.strictEqual(rebased.baselineRevision, 3);
assert.strictEqual(rebased.fields.find((f) => f.uid === 'u-name')?.key, 'title');
assert.strictEqual(rebased.fields.some((f) => f.uid === 'u-note'), true);
assert.strictEqual(rebased.mappings.length, 1);
ok('后提交草稿 rebase：草稿改名保住、新版本新增字段并入、对照保留，基线升到 v3', true);

// 7) makeField 生成的默认标识唯一
const f1 = makeField('x'); const f2 = makeField('x');
assert.notStrictEqual(f1.key, f2.key);
ok('新字段默认标识不撞车', true);

console.log(`\n全部 ${passed} 项断言通过`);
