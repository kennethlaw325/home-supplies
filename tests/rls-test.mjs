// 屋企日用品計算器 L5 —— RLS 測試（單 household 版）
//
// 跑法：cd tests && npm install && npm test
//
// 用 PGlite（喺 node 入面行嘅真 Postgres）跑真 schema.sql，唔使開 Supabase。
// Supabase 嗰邊獨有嘅只有 auth.jwt()，喺下面用 request.jwt.claims 補返個 stub。

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', 'schema.sql');

const ADMIN = 'kennethlaw325a@gmail.com';  // seed 嗰個管理人
const STAFF = 'chantai@example.com';       // 店員
const VIEWER = 'auntie@example.com';       // 親友（唯讀）
const PENDING = 'newbie@example.com';      // 等緊批准

const db = await PGlite.create();
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`);
};

await db.exec(`
  create role anon;
  create role authenticated;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable
    as $$ select coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb $$;
`);

// schema.sql 最尾嗰行 seed email 係個 placeholder，測試度換做真 admin
const schema = readFileSync(SCHEMA_PATH, 'utf8')
  .replace('<你嘅Gmail@gmail.com>', ADMIN);
if (schema.includes('<你嘅Gmail')) throw new Error('seed placeholder 換唔到，schema 改咗格式？');
await db.exec(schema);

async function as(email, fn) {
  await db.exec('set role authenticated;');
  await db.query('select set_config($1, $2, false)',
    ['request.jwt.claims', email ? JSON.stringify({ email }) : '{}']);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}

async function expectFail(name, email, fn, wants) {
  try {
    await as(email, fn);
    check(name, false, '冇報錯（應該要俾擋）');
  } catch (error) {
    const message = String(error.message);
    check(name, message.toLowerCase().includes(wants.toLowerCase()), message.split('\n')[0]);
  }
}

let idSeq = 0;
const newId = () => `r${Date.now()}-${++idSeq}`;

const insertRecord = (id = newId(), name = '廁紙', createdBy = null) => db.query(
  `insert into public.records (id, name, kind, qty, amount, date${createdBy ? ', created_by' : ''})
   values ($1, $2, 'buy', 10, 45, '2026-08-13'${createdBy ? ', $3' : ''})`,
  createdBy ? [id, name, createdBy] : [id, name]);

const setThreshold = (name = '廁紙', value = 4) => db.query(
  `insert into public.thresholds (name, threshold) values ($1, $2)
   on conflict (name) do update set threshold = excluded.threshold`, [name, value]);

// ───────── 起底：加三個成員（模擬管理人喺成員管理批咗人）─────────
await db.exec(`
  insert into public.members (email, display_name, role) values
    ('${STAFF}',   '陳太',   'staff'),
    ('${VIEWER}',  '親友',   'viewer'),
    ('${PENDING}', '生人',   'pending');
`);

const ADMIN_RECORD_ID = 'r-admin-1';
await as(ADMIN, () => insertRecord(ADMIN_RECORD_ID, '廁紙'));
await as(ADMIN, () => setThreshold('廁紙', 4));

// ═════════ 1. 四級角色 × 讀 ═════════
for (const [email, label, canRead] of [
  [ADMIN, '管理人', true], [STAFF, '店員', true],
  [VIEWER, '親友', true], [PENDING, '等批准', false]
]) {
  await as(email, async () => {
    const records = (await db.query('select name from public.records')).rows;
    const thresholds = (await db.query('select name from public.thresholds')).rows;
    check(`${label}${canRead ? '讀到' : '讀唔到'}紀錄`,
      (records.length > 0) === canRead, `${records.length} 筆`);
    check(`${label}${canRead ? '讀到' : '讀唔到'}門檻`,
      (thresholds.length > 0) === canRead, `${thresholds.length} 行`);
  });
}

// ═════════ 2. 四級角色 × 寫 ═════════
await as(ADMIN, () => insertRecord(newId(), '洗潔精'));
check('管理人入到數', true);
await as(STAFF, () => insertRecord(newId(), '牙膏'));
check('店員入到數', true);
await as(STAFF, () => setThreshold('牙膏', 2));
check('店員設到門檻', true);

await expectFail('親友入唔到數', VIEWER, () => insertRecord(newId(), '親友亂入'), 'row-level security');
await expectFail('親友設唔到門檻', VIEWER, () => setThreshold('親友亂入', 1), 'row-level security');
await expectFail('等批准入唔到數', PENDING, () => insertRecord(newId(), 'pending 亂入'), 'row-level security');
await expectFail('等批准設唔到門檻', PENDING, () => setThreshold('pending 亂入', 1), 'row-level security');

await as(VIEWER, async () => {
  const updated = (await db.query(
    `update public.records set qty = 999 where id = $1`, [ADMIN_RECORD_ID])).affectedRows;
  check('親友改唔到數（0 行受影響）', updated === 0, `${updated} 行`);
  const deleted = (await db.query(
    `delete from public.records where id = $1`, [ADMIN_RECORD_ID])).affectedRows;
  check('親友刪唔到數（0 行受影響）', deleted === 0, `${deleted} 行`);
  const wiped = (await db.query('delete from public.thresholds')).affectedRows;
  check('親友清唔到門檻（0 行受影響）', wiped === 0, `${wiped} 行`);
});

await as(STAFF, async () => {
  const updated = (await db.query(
    `update public.records set qty = 12 where id = $1`, [ADMIN_RECORD_ID])).affectedRows;
  check('店員改得管理人開嘅紀錄', updated === 1, `${updated} 行`);
});

// ═════════ 3. 自升 admin 各路徑 ═════════
await expectFail('等批准 INSERT 唔到一行 admin 俾自己', PENDING,
  () => db.query(`insert into public.members (email, display_name, role)
                  values ($1, '自封', 'admin')`, ['brandnew@example.com']),
  'row-level security');

await expectFail('生人排隊只准開自己 email', 'stranger@example.com',
  () => db.query(`insert into public.members (email, role) values ($1, 'pending')`, [STAFF]),
  'row-level security');

await as('stranger@example.com', async () => {
  await db.query(`insert into public.members (email, display_name, role)
                  values ($1, '生人', 'pending')`, ['stranger@example.com']);
  check('生人開得自己嗰行 pending（正常排隊）', true);
});

for (const [email, label] of [[STAFF, '店員'], [VIEWER, '親友'], [PENDING, '等批准']]) {
  await as(email, async () => {
    const promoted = (await db.query(
      `update public.members set role = 'admin' where lower(email) = lower($1)`, [email])).affectedRows;
    check(`${label} UPDATE 自升唔到 admin（0 行受影響）`, promoted === 0, `${promoted} 行`);
    const demoted = (await db.query(
      `update public.members set role = 'pending' where lower(email) = lower($1)`, [ADMIN])).affectedRows;
    check(`${label} 貶唔到管理人（0 行受影響）`, demoted === 0, `${demoted} 行`);
    const removed = (await db.query(
      `delete from public.members where lower(email) = lower($1)`, [ADMIN])).affectedRows;
    check(`${label} 移除唔到管理人（0 行受影響）`, removed === 0, `${removed} 行`);
  });
}

await as(ADMIN, async () => {
  const promoted = (await db.query(
    `update public.members set role = 'staff' where lower(email) = lower($1)`, [PENDING])).affectedRows;
  check('管理人批准得 pending 做店員', promoted === 1, `${promoted} 行`);
  await db.query(`update public.members set role = 'pending' where lower(email) = lower($1)`, [PENDING]);
});

// ═════════ 4. pending 乜都睇唔到 ═════════
await as(PENDING, async () => {
  const records = (await db.query('select id from public.records')).rows.length;
  const thresholds = (await db.query('select name from public.thresholds')).rows.length;
  const members = (await db.query('select email from public.members')).rows;
  check('等批准一筆紀錄都睇唔到', records === 0, `${records} 筆`);
  check('等批准一個門檻都睇唔到', thresholds === 0, `${thresholds} 行`);
  check('等批准只睇到自己嗰行成員', members.length === 1 && members[0].email === PENDING,
    members.map((m) => m.email).join(',') || '(零)');
});

await as(STAFF, async () => {
  const members = (await db.query('select email from public.members')).rows;
  check('店員都係只睇到自己嗰行成員（成員名單係管理人專屬）',
    members.length === 1 && members[0].email === STAFF, `${members.length} 行`);
});

// ═════════ 5. created_by 偽造 ═════════
await expectFail('INSERT 自填第二個人個 email → 俾彈走', STAFF,
  () => insertRecord(newId(), '偽造', ADMIN), 'row-level security');

await as(STAFF, () => db.query(
  `update public.records set qty = 5, created_by = $2 where id = $1`, [ADMIN_RECORD_ID, STAFF]));
const afterUpdate = (await db.query(
  `select qty, created_by from public.records where id = $1`, [ADMIN_RECORD_ID])).rows[0];
check('UPDATE 篡改 created_by 無效（trigger 鎖返）', afterUpdate.created_by === ADMIN, afterUpdate.created_by);
check('但同一句 UPDATE 其他欄照生效', Number(afterUpdate.qty) === 5, `qty=${afterUpdate.qty}`);

// 刪咗再用同一個 id 開返 —— 冇 claim trigger 嘅話呢條就係偽造路
await as(STAFF, async () => {
  const deleted = (await db.query(
    `delete from public.records where id = $1`, [ADMIN_RECORD_ID])).affectedRows;
  check('店員刪得走管理人嗰筆（佢本身有刪權）', deleted === 1, `${deleted} 行`);
});
await expectFail('刪咗再用同一個 id 開返 → 俾彈走（created_by 偽造路封咗）', STAFF,
  () => insertRecord(ADMIN_RECORD_ID, '偽造重生'), '用過');
await expectFail('連管理人自己都唔准重用 id', ADMIN,
  () => insertRecord(ADMIN_RECORD_ID, '管理人重生'), '用過');

const ghost = (await db.query(
  `select count(*)::int as n from public.records where id = $1`, [ADMIN_RECORD_ID])).rows[0].n;
check('偽造嘅行真係入唔到去', ghost === 0, `${ghost} 行`);

await expectFail('客戶端直接叫 private.my_role() 俾拒絕', STAFF,
  () => db.query('select private.my_role()'), 'permission denied');
await expectFail('客戶端摸唔到用過嘅 id 名冊', STAFF,
  () => db.query('select * from private.used_record_ids'), 'permission denied');

// ═════════ 6. 未登入（anon）直讀直寫 ═════════
await db.exec('set role anon;');
for (const [label, sql] of [
  ['讀 records', 'select * from public.records'],
  ['讀 members', 'select * from public.members'],
  ['讀 thresholds', 'select * from public.thresholds'],
  ['寫 records', `insert into public.records (id, name, kind, qty, amount, date)
                  values ('anon-1', 'anon 亂入', 'buy', 1, 1, '2026-08-13')`],
  ['寫 members', `insert into public.members (email, role) values ('anon@example.com', 'admin')`],
  ['寫 thresholds', `insert into public.thresholds (name, threshold) values ('anon', 1)`]
]) {
  try {
    await db.query(sql);
    check(`未登入${label}俾拒絕`, false, '冇報錯');
  } catch (error) {
    check(`未登入${label}俾拒絕`, /permission denied/i.test(error.message), error.message.split('\n')[0]);
  }
}
await db.exec('reset role;');

// ═════════ 7. policy / trigger 數目 ═════════
const policies = (await db.query(
  `select count(*)::int as n from pg_policies where schemaname = 'public'`)).rows[0].n;
check('13 條 policy（members 5 + records 4 + thresholds 4）', policies === 13, `${policies} 條`);

const triggers = (await db.query(
  `select count(*)::int as n from pg_trigger
   where tgrelid = 'public.records'::regclass and not tgisinternal`)).rows[0].n;
check('records 有 2 個 trigger（鎖 created_by + 唔准重用 id）', triggers === 2, `${triggers} 個`);

const failed = results.filter((pass) => !pass).length;
console.log(`\n總結：${results.length - failed}/${results.length} PASS${failed ? `  ⚠ ${failed} FAIL` : '  全部通過'}`);
process.exit(failed ? 1 : 0);
