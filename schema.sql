-- =====================================================================
--  屋企日用品計算器 L5 —— Supabase schema（tables + RLS policies + seed）
--
--  點用：Supabase Dashboard → SQL Editor → New query → 成份貼落去 → Run
--  可以重複跑（會先 drop 舊嘅），中途改咗嘢就再跑一次。
--
--  ⚠️⚠️ 重跑會清走嘅嘢：
--       · public.records     —— 全部買咗／用咗紀錄
--       · public.thresholds  —— 全部低量門檻
--       · public.members     —— 全部成員同角色（批准過嘅人要重新批）
--       · schema private     —— cascade 埋 my_role() / keep_created_by() /
--                               used_record_ids（用過嘅 id 名冊）
--       重跑之後只會剩返第 7 節 seed 嗰一個 admin。
--       跑之前：Table Editor 開 members 抄低 email + role；records / thresholds
--       撳 Export → CSV 落本機。唔匯出＝明知放棄晒。
--
--  最尾第 7 節有一行要改做你自己個 Gmail。
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. 清走舊版（方便重跑）
-- ---------------------------------------------------------------------
drop table if exists public.records cascade;
drop table if exists public.thresholds cascade;
drop table if exists public.members cascade;
drop schema if exists private cascade;


-- ---------------------------------------------------------------------
--  2. members —— 邊個入得，做邊個角色
--     用 email 做 key（唔用 user id），因為 auth.uid() 要對方登入過先存在。
--     ⚠️ 呢個唔等於前端加得人：唯一嘅 INSERT policy 只准登入者為自己
--        開一行 pending。實際 flow 係「對方自己登入 → 排隊 → 管理人批准」。
-- ---------------------------------------------------------------------
create table public.members (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  display_name text,
  role         text not null default 'pending'
               check (role in ('admin', 'staff', 'viewer', 'pending')),
  created_at   timestamptz not null default now()
);

-- 大細楷唔同都當同一個人（Gmail 唔分大細楷）
create unique index members_email_lower_idx on public.members (lower(email));


-- ---------------------------------------------------------------------
--  3. records —— 「發生過嘅事」，同 app 入面 record object 一一對應
--     欄名特登同 JS 一模一樣（id / name / kind / qty / amount / date），
--     所以前端唔使寫任何 camelCase ↔ snake_case 轉換碼。
--
--     id 係 text 唔係 uuid：app 一直用 'r<timestamp>-<random>' 做 id，
--     舊 localStorage 紀錄要原樣搬得上嚟。
--
--     seq 係寫入次序。物品出場次序 = 第一次入嗰筆嘅次序，靠佢還原，
--     唔可以淨係靠 date（同一日入幾筆就分唔到先後）。
-- ---------------------------------------------------------------------
create table public.records (
  id         text primary key,
  seq        bigint generated always as identity,
  name       text not null,
  kind       text not null check (kind in ('buy', 'use')),
  qty        numeric not null check (qty > 0),
  amount     numeric not null default 0 check (amount >= 0),
  date       date not null,
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);

create index records_seq_idx on public.records (seq);


-- ---------------------------------------------------------------------
--  4. thresholds —— 每樣物品嘅低量門檻（app 入面本來係一個
--     { 物品名: 數字 } 嘅 object，一行一個 key）
--     留白 = 唔設門檻 = 冇呢一行（唔係存 null），同 app 行為對齊。
-- ---------------------------------------------------------------------
create table public.thresholds (
  name       text primary key,
  threshold  numeric not null check (threshold >= 0),
  updated_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
--  5. 權限 helper + 防篡改
--
--  點解要 security definer：members 自己都開咗 RLS，如果 members 嘅 policy
--  直接 select members，Postgres 會無限遞迴。security definer 令個 function
--  以 owner 身分行、跳過 RLS，遞迴即刻斷。
--
--  點解放喺 private schema：Supabase 官方明講 security definer function
--  唔可以放喺對外 expose 嘅 schema（即係 public），否則客戶端直接叫得。
-- ---------------------------------------------------------------------
create schema if not exists private;

create or replace function private.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role
  from public.members m
  where lower(m.email) = lower(auth.jwt() ->> 'email')
  limit 1
$$;

revoke all on function private.my_role() from public, anon;
grant execute on function private.my_role() to authenticated;


-- id 同 created_by 一旦寫低，喺呢一行上面就唔准再改。
-- 點解用 trigger 而唔係喺 UPDATE policy 個 with check 度釘死：
-- RLS 嘅 with check 只睇得到改完之後嗰行，冇 OLD 可以對照。喺嗰度寫
-- `created_by = auth.jwt()->>'email'` 會連帶令店員改唔到人哋開嘅紀錄。
-- trigger 就啱啱好：鎖死呢兩欄，其他欄照改。
--
-- 點解連 id 都要鎖：下面個 claim trigger 只守 INSERT，UPDATE 冇人守。
-- 唔鎖 id 嘅話，店員可以（1）開自己一筆 Z（2）刪走管理人嗰筆 R
-- （3）`update records set id = 'R' where id = 'Z'` —— 冇經過 INSERT，
-- 名冊唔知情，created_by 又照留返佢自己，即係繞返出「刪咗再開」條路。
-- app 本身從來唔改 id（新一筆一定係 INSERT），所以直接釘死冇副作用。
create or replace function private.keep_created_by()
returns trigger
language plpgsql
as $$
begin
  new.id := old.id;
  new.created_by := old.created_by;
  return new;
end;
$$;

create trigger records_keep_created_by
before update on public.records
for each row execute function private.keep_created_by();


-- 堵住「刪咗再開」嗰條偽造路。
--
-- 冇呢一段嘅話：keep_created_by 淨係擋 UPDATE，店員照樣可以
--   delete from records where id = 'r123'          （佢刪得走管理人開嘅行）
--   insert into records (id, ...) values ('r123', ...)   （新行 created_by = 佢自己）
-- 結果同直接改咗 created_by 冇分別 —— audit 欄講嘅嘢就唔算數。
--
-- 做法：用過嘅 id 入名冊，名冊喺 private schema（authenticated 冇任何
-- grant，客戶端刪唔到、睇唔到），再用同一個 id 開新行就即刻彈走。
create table private.used_record_ids (
  id         text primary key,
  created_by text,
  first_seen timestamptz not null default now()
);
-- ponytail: 名冊只加唔減，清空紀錄之後啲 id 一世留低。呢個 app 一日
-- 幾筆數，行到落世都唔會大。真係要 GC 就加一句「N 年前 + 已刪」先准清。

create or replace function private.claim_record_id()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
begin
  insert into private.used_record_ids (id, created_by)
  values (new.id, new.created_by);
  return new;
exception when unique_violation then
  raise exception '呢個紀錄 id 用過咗，唔准刪咗再用同一個 id 開返新嘅（id=%）', new.id
    using errcode = 'check_violation';
end;
$$;

create trigger records_claim_id
before insert on public.records
for each row execute function private.claim_record_id();


-- ---------------------------------------------------------------------
--  6. RLS —— 真正嘅權限邊界
--     App 入面收埋啲掣只係 UX；就算有人用 publishable key 直接 call API，
--     都要過呢一層。
-- ---------------------------------------------------------------------
alter table public.members    enable row level security;
alter table public.records    enable row level security;
alter table public.thresholds enable row level security;

-- 未登入（有 key 但冇 login）乜都掂唔到
revoke all on public.members    from anon;
revoke all on public.records    from anon;
revoke all on public.thresholds from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.members    to authenticated;
grant select, insert, update, delete on public.records    to authenticated;
grant select, insert, update, delete on public.thresholds to authenticated;


-- ····· members 嘅 policies ·····

-- 任何登入者都睇到自己嗰行（生人要靠呢條先知自己 pending 緊）
create policy "members: 睇自己"
on public.members for select
to authenticated
using ( lower(email) = lower(auth.jwt() ->> 'email') );

-- 管理人睇晒全部
create policy "members: 管理人睇晒"
on public.members for select
to authenticated
using ( private.my_role() = 'admin' );

-- 生人第一次登入自己排隊：只准開自己 email，而且一定係 pending
-- （唔可以自己開個 admin 出嚟）
create policy "members: 自己排隊等批"
on public.members for insert
to authenticated
with check (
  lower(email) = lower(auth.jwt() ->> 'email')
  and role = 'pending'
);

-- 只有管理人改得權限
create policy "members: 管理人改權限"
on public.members for update
to authenticated
using      ( private.my_role() = 'admin' )
with check ( private.my_role() = 'admin' );

-- 只有管理人移除得成員
create policy "members: 管理人移除"
on public.members for delete
to authenticated
using ( private.my_role() = 'admin' );


-- ····· records 嘅 policies ·····

-- 管理人 / 店員 / 親友 三個都睇得數
create policy "records: 有身分就睇得"
on public.records for select
to authenticated
using ( private.my_role() in ('admin', 'staff', 'viewer') );

-- 只有管理人同店員入得數
-- created_by 釘死係登入者本人：app 唔會送呢個欄，靠上面個 DEFAULT 填。
-- 有人繞過 UI 直接 call API 自填第二個人個 email，就會喺呢度俾彈走。
-- （email claim 攞唔到就 = NULL，條件唔成立 → 一樣拒絕，fail closed。）
create policy "records: 管理人同店員入數"
on public.records for insert
to authenticated
with check (
  private.my_role() in ('admin', 'staff')
  and created_by = (auth.jwt() ->> 'email')
);

create policy "records: 管理人同店員改數"
on public.records for update
to authenticated
using      ( private.my_role() in ('admin', 'staff') )
with check ( private.my_role() in ('admin', 'staff') );

create policy "records: 管理人同店員刪數"
on public.records for delete
to authenticated
using ( private.my_role() in ('admin', 'staff') );


-- ····· thresholds 嘅 policies ·····
-- 門檻係設定唔係 audit 對象，所以冇 created_by；讀寫權同 records 一樣。

create policy "門檻: 有身分就睇得"
on public.thresholds for select
to authenticated
using ( private.my_role() in ('admin', 'staff', 'viewer') );

create policy "門檻: 管理人同店員設定"
on public.thresholds for insert
to authenticated
with check ( private.my_role() in ('admin', 'staff') );

create policy "門檻: 管理人同店員改"
on public.thresholds for update
to authenticated
using      ( private.my_role() in ('admin', 'staff') )
with check ( private.my_role() in ('admin', 'staff') );

create policy "門檻: 管理人同店員刪"
on public.thresholds for delete
to authenticated
using ( private.my_role() in ('admin', 'staff') );


-- ---------------------------------------------------------------------
--  7. Seed —— 開一個管理人，否則冇人批得人入嚟
--
--  ⬇⬇⬇  跑之前一定要改呢一行：換做你自己個 Gmail  ⬇⬇⬇
--  就係你等陣撳「用 Google 登入」嗰個帳號。唔改就冇人做得管理人，
--  你登入完會卡喺「等批准」畫面，冇人批得到你。
--  （連個 `<` `>` 一齊刪走，例：'admin@example.com'）
--  lower() 係特登嘅：全表 email 一律細楷存，客戶端就可以用 eq 直接對得返
--  Google 送過嚟嗰個（大細楷唔同都當同一個人，靠上面個 lower unique index）。
-- ---------------------------------------------------------------------
insert into public.members (email, display_name, role)
values (lower('<你嘅Gmail@gmail.com>'), '我（管理人）', 'admin')
on conflict do nothing;


-- ---------------------------------------------------------------------
--  8. 跑完自己核對
-- ---------------------------------------------------------------------
-- 應該見到 1 行 admin：
select email, display_name, role from public.members;

-- 應該見到 13 條 policy（members 5 + records 4 + thresholds 4）：
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

-- 應該見到 2 個 trigger（鎖死 id + created_by ＋ 用過嘅 id 唔准重用）：
select tgname from pg_trigger
where tgrelid = 'public.records'::regclass and not tgisinternal
order by tgname;
