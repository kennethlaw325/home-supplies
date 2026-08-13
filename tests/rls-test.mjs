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

const ADMIN = 'admin@example.com';         // seed 嗰個管理人
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

await as(VIEWER, async () => {
  const members = (await db.query('select email from public.members')).rows;
  check('親友都係只睇到自己嗰行成員',
    members.length === 1 && members[0].email === VIEWER, `${members.length} 行`);
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

// 上面條路封咗之後仲有一條：唔洗 INSERT，改個 id 就搶到人哋嗰筆
// （開自己一筆 → 刪走管理人嗰筆 → rename 自己嗰筆做管理人個 id）
const VICTIM_ID = 'r-admin-2';
const SWAP_ID = 'r-staff-swap';
await as(ADMIN, () => insertRecord(VICTIM_ID, '管理人第二筆'));
await as(STAFF, async () => {
  await insertRecord(SWAP_ID, '店員自己嗰筆');
  const deleted = (await db.query(
    `delete from public.records where id = $1`, [VICTIM_ID])).affectedRows;
  check('店員刪得走管理人第二筆（佢本身有刪權）', deleted === 1, `${deleted} 行`);
  await db.query(`update public.records set id = $1 where id = $2`, [VICTIM_ID, SWAP_ID]);
});
const afterSwap = (await db.query(
  `select id, created_by from public.records where id in ($1, $2) order by id`,
  [VICTIM_ID, SWAP_ID])).rows;
check('UPDATE 改唔到 records.id（trigger 釘死，rename 偽造路封咗）',
  afterSwap.length === 1 && afterSwap[0].id === SWAP_ID,
  JSON.stringify(afterSwap));
check('管理人嗰個 id 冇俾人搶咗嚟用', afterSwap.every((r) => r.id !== VICTIM_ID),
  afterSwap.map((r) => `${r.id}:${r.created_by}`).join(', '));

// ═════════ 6. UPSERT（on conflict do update）—— 同 INSERT 唔同嘅 policy 路 ═════════
// PG 喺 conflict path 會跳過 INSERT policy 個 with check，改行 UPDATE policy。
// PostgREST 一個 `Prefer: resolution=merge-duplicates` header 就行得到呢條路。
const staffRow = await as(STAFF, async () => (await db.query(
  `select id from public.members where lower(email) = lower($1)`, [STAFF])).rows[0]);
check('店員攞到自己嗰行 members id（下面 upsert 測試要用）', !!staffRow,
  staffRow ? staffRow.id : '(攞唔到)');

await expectFail('店員 upsert(on conflict id) 自升唔到 admin', STAFF,
  () => db.query(`insert into public.members (id, email, display_name, role)
                  values ($1, $2, '陳太', 'pending')
                  on conflict (id) do update set role = 'admin'`, [staffRow.id, STAFF]),
  'row-level security');
const staffRoleNow = (await db.query(
  `select role from public.members where lower(email) = lower($1)`, [STAFF])).rows[0].role;
check('店員 upsert 完之後仲係店員', staffRoleNow === 'staff', staffRoleNow);

const UPSERT_VICTIM_ID = 'r-admin-3';
await as(ADMIN, () => insertRecord(UPSERT_VICTIM_ID, '管理人第三筆'));
await expectFail('店員 upsert(on conflict id) 覆寫唔到人哋嘅 created_by', STAFF,
  () => db.query(`insert into public.records (id, name, kind, qty, amount, date, created_by)
                  values ($1, '搶單', 'buy', 1, 1, '2026-08-13', $2)
                  on conflict (id) do update set created_by = excluded.created_by`,
    [UPSERT_VICTIM_ID, STAFF]),
  '用過');
const upsertVictim = (await db.query(
  `select created_by from public.records where id = $1`, [UPSERT_VICTIM_ID])).rows[0];
check('管理人嗰筆嘅 created_by 冇俾 upsert 改到', upsertVictim.created_by === ADMIN,
  upsertVictim.created_by);

// 一定要 upsert 一個**已經存在**嘅 name，先至踩到 conflict path
await expectFail('親友 upsert 一個已存在嘅門檻 → 俾彈走', VIEWER,
  () => setThreshold('廁紙', 99), 'row-level security');
const thresholdNow = (await db.query(
  `select threshold from public.thresholds where name = '廁紙'`)).rows[0];
check('廁紙門檻冇俾親友 upsert 改到', Number(thresholdNow.threshold) === 4,
  `threshold=${thresholdNow.threshold}`);

// ═════════ 7. 大細楷 round-trip ═════════
// 成個設計靠 lower()：unique index、my_role()、睇自己、排隊全部 lower。
const ADMIN_MIXED = 'ADMIN@Example.COM';
if (ADMIN_MIXED.toLowerCase() !== ADMIN) throw new Error('casing 測試個 email 對唔返 ADMIN');
await as(ADMIN_MIXED, async () => {
  const members = (await db.query('select email from public.members')).rows.length;
  const records = (await db.query('select id from public.records')).rows.length;
  check('大細楷唔同嘅 JWT email 一樣認得返係管理人（睇到成個名單）', members > 1, `${members} 行`);
  check('大細楷唔同嘅 JWT email 一樣讀到紀錄', records > 0, `${records} 筆`);
});
await expectFail('同一個 email 換個大細楷開唔到第二行 members', ADMIN_MIXED,
  () => db.query(`insert into public.members (email, display_name, role)
                  values ($1, '大細楷分身', 'pending')`, [ADMIN_MIXED]),
  'duplicate key');

// ═════════ 8. fail-closed：冇 members 行 / JWT 冇 email claim ═════════
const NOBODY = 'nobody@example.com';
await as(NOBODY, async () => {
  const records = (await db.query('select id from public.records')).rows.length;
  const members = (await db.query('select email from public.members')).rows.length;
  check('OAuth 過咗但 members 未有行：一筆紀錄都睇唔到', records === 0, `${records} 筆`);
  check('OAuth 過咗但 members 未有行：成員名單零行', members === 0, `${members} 行`);
});
await expectFail('OAuth 過咗但 members 未有行：入唔到數', NOBODY,
  () => insertRecord(newId(), '無名氏亂入'), 'row-level security');

await as(null, async () => {
  const records = (await db.query('select id from public.records')).rows.length;
  const members = (await db.query('select email from public.members')).rows.length;
  check('JWT claims 空（冇 email）：一筆紀錄都睇唔到', records === 0, `${records} 筆`);
  check('JWT claims 空（冇 email）：成員名單零行', members === 0, `${members} 行`);
});
await expectFail('JWT claims 空（冇 email）：入唔到數', null,
  () => insertRecord(newId(), '無 claim 亂入'), 'row-level security');

// ═════════ 9. 未登入（anon）直讀直寫 ═════════
// PGlite 個 anon 係測試自己 create 出嚟，本身就零權 —— 即係刪走 schema.sql
// 嗰三句 revoke，下面六條照樣 PASS（空驗）。所以先模擬 Supabase 個 default
// grant（ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon），驗埋
// 「就算有 grant，RLS 都守得住」，再用返 schema.sql 原文嗰三句 revoke 收。
const revokeLines = schema.split('\n')
  .map((line) => line.trim())
  .filter((line) => /^revoke all on public\..+from anon;$/.test(line));
check('schema.sql 有三句 revoke ... from anon（冇咗就係 regression）',
  revokeLines.length === 3, `${revokeLines.length} 句`);

await db.exec('grant all on public.members, public.records, public.thresholds to anon;');
await db.exec('set role anon;');
const anonGrantedRead = (await db.query('select * from public.records')).rows.length;
check('anon 就算攞到 table grant，RLS 一樣讀 0 行', anonGrantedRead === 0, `${anonGrantedRead} 筆`);
try {
  await db.query(`insert into public.records (id, name, kind, qty, amount, date)
                  values ('anon-grant-1', 'anon 亂入', 'buy', 1, 1, '2026-08-13')`);
  check('anon 就算攞到 table grant，RLS 一樣寫唔入', false, '冇報錯');
} catch (error) {
  check('anon 就算攞到 table grant，RLS 一樣寫唔入',
    /row-level security/i.test(error.message), error.message.split('\n')[0]);
}
await db.exec('reset role;');
await db.exec(revokeLines.join('\n'));

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

// ═════════ 10. policy / trigger 數目 ═════════
const policies = (await db.query(
  `select count(*)::int as n from pg_policies where schemaname = 'public'`)).rows[0].n;
check('13 條 policy（members 5 + records 4 + thresholds 4）', policies === 13, `${policies} 條`);

const triggers = (await db.query(
  `select count(*)::int as n from pg_trigger
   where tgrelid = 'public.records'::regclass and not tgisinternal`)).rows[0].n;
check('records 有 2 個 trigger（鎖死 id + created_by ＋ 唔准重用 id）', triggers === 2, `${triggers} 個`);

const failed = results.filter((pass) => !pass).length;
console.log(`\n總結：${results.length - failed}/${results.length} PASS${failed ? `  ⚠ ${failed} FAIL` : '  全部通過'}`);
process.exit(failed ? 1 : 0);
