# SETUP：接通 Supabase + Google 登入（導師版）

呢張卡係將「屋企日用品計算器」由本機 localStorage 版，變成**有真後端、真 Google 登入、真角色權限**嘅版本，
擺得上 GitHub Pages 俾學生撳。全程約 10 分鐘。

> **未做呢張卡之前** —— `index.html` 開出嚟係「backend 未接」設定提示頁（唔會白畫面，亦都唔會靜靜雞退返去本機儲存）。
> 見到嗰版就即係第 8 步未做。

呢個 app 嘅 live 網址（下面成張卡都會用到）：

```
https://kennethlaw325.github.io/home-supplies/
```

---

## 開波前

準備三樣：

- 一個 Google 帳戶 —— 就係你之後做**管理人**嗰個
- **第二個 Google 帳戶** —— 第 9 步嘅 checklist #6 到 #10（排隊／批准／店員／親友）冇第二個帳戶做唔到。
  兩個都要喺第 5 步加做 **Test user**
- 呢個 repo：`index.html`、`schema.sql`

⚠️ **Google 登入唔支援 `file://` 直接開檔。** 本機測要行第 8 步嗰句 `python -m http.server 8000`；
出街版就直接用上面條 GitHub Pages 網址。

---

## 步驟 1／開 Supabase project（2 分鐘）

1. 去 https://supabase.com → **Start your project** → 用 GitHub 或 Google 登入
2. 撳 **New project**
   - **Name**：`home-supplies`
   - **Database Password**：撳 Generate，**存落密碼管理器**（呢個唔係登入 app 用嘅，係資料庫密碼）
   - **Region**：揀 `Southeast Asia (Singapore)`
3. 撳 **Create new project**

✅ **應該見到**：project dashboard。頂部個進度條寫 "Setting up project"，等佢變返正常 dashboard 先繼續。

---

## 步驟 2／改 schema.sql 入面嘅管理人 email（30 秒）

用記事本開 `schema.sql`，捲到最底 **第 7 節**：

```sql
insert into public.members (email, display_name, role)
values ('<你嘅Gmail@gmail.com>', '我（管理人）', 'admin')
```

改做**你打算用嚟登入嗰個 Google email**，連 `<` `>` 一齊刪走。

✅ **撳 Run 之前核一次**：嗰行冇咗 `<` 同 `>`，入面係你真係會用嚟登入嗰個 Gmail。
（留住 placeholder 就冇人做得管理人，你登入完會卡喺「等批准」而且冇人批得到你。）

---

## 步驟 3／跑 schema.sql（1 分鐘）

1. Supabase 左邊欄撳 **SQL Editor** → **New query**
2. 將 `schema.sql` **成份**（由第一行到最後一行）copy 落個編輯器
3. 撳右下角 **Run**（或者 Ctrl+Enter）

✅ **應該見到**底下 Results 出三個表：

| 表 | 應該係 |
|---|---|
| 第一個 | 1 行：你個 email + `我（管理人）` + `admin` |
| 第二個 | **13 行 policy**（`members` 5 條、`records` 4 條、`thresholds` 4 條） |
| 第三個 | **2 行 trigger**：`records_claim_id`、`records_keep_created_by` |

❌ 紅色 error：多數係 copy 漏咗頭或者尾。全選再 copy 一次。

---

## 步驟 4／喺 Supabase 攞 Google 嘅 callback URL（30 秒）

1. 左邊欄 **Authentication** → **Sign In / Providers**
2. 喺 provider 清單搵 **Google**，撳入去，打開個掣（Enable Sign in with Google）
3. 望落下面，有一格 **Callback URL (for OAuth)**，樣衰似：
   ```
   https://abcdefghijklm.supabase.co/auth/v1/callback
   ```
4. 撳 copy 抄低佢，**呢一頁唔好閂**（第 6 步要返嚟填嘢）

---

## 步驟 5／喺 Google Cloud Console 開 OAuth client（4 分鐘）

1. 去 https://console.cloud.google.com/
2. 頂部揀 project（冇就撳 **New Project**，名隨便，Create 完喺頂部揀返佢）
3. 左上漢堡 → **APIs & Services** → **OAuth consent screen**
   - **Branding**：App name 填 `屋企日用品計算器`、User support email 揀你自己、Developer contact 填你 email → Save
   - **Audience** 揀 **External** → Save
   - 仲喺 **Audience** 頁面，下面 **Test users** → **Add users** → 加**兩個 email**：
     - 你自己（管理人嗰個，同 `schema.sql` 第 7 節填嗰個一樣）
     - 你部測試機／第二個帳戶嗰個（試「排隊 → 批准」流程要用）

     > ⚠️ 冇加做 Test user 嘅人撳「用 Google 登入」會俾 **Google** 直接擋
     > （"has not completed the Google verification process"），連 app 個「等批准」畫面都見唔到。

4. 左邊撳 **Clients** → **Create client**
   - **Application type**：`Web application`
   - **Name**：`home-supplies`
   - **Authorised JavaScript origins** → **ADD URI**，加**兩條**（要 origin，冇尾斜線、冇路徑）：
     ```
     https://kennethlaw325.github.io
     http://localhost:8000
     ```
   - **Authorised redirect URIs** → **ADD URI** → 貼**第 4 步抄低嗰條 Supabase callback URL**：
     ```
     https://<你個 project>.supabase.co/auth/v1/callback
     ```
     > 呢度貼嘅係 **Supabase 嗰條**，唔係 GitHub Pages、唔係 localhost。好多人喺呢度填錯。
   - 撳 **Create**

✅ **應該見到**：彈個框出嚟，有 **Client ID**（`xxxxx.apps.googleusercontent.com`）同 **Client secret**。兩個都抄低。

---

## 步驟 6／填返落 Supabase：Google key ＋ URL 配置（2 分鐘）

**6a. Google key**

1. 返去第 4 步嗰版（Supabase → Authentication → Sign In / Providers → Google）
2. **Client IDs**：貼 Google 嘅 Client ID
3. **Client Secret (for OAuth)**：貼 Google 嘅 Client secret
4. 撳 **Save**

✅ Google 喺 provider 清單顯示 **Enabled**。

**6b. URL Configuration（呢版最易漏，漏咗＝認完 Google 跳唔返嚟）**

左邊欄 **Authentication** → **URL Configuration**：

| 格 | 填 |
|---|---|
| **Site URL** | `https://kennethlaw325.github.io/home-supplies/` |
| **Redirect URLs** → Add URL | `https://kennethlaw325.github.io/home-supplies/` |
| **Redirect URLs** → Add URL | `https://kennethlaw325.github.io/home-supplies/**` |
| **Redirect URLs** → Add URL | `http://localhost:8000` |
| **Redirect URLs** → Add URL | `http://localhost:8000/**` |

撳 **Save**。

> 帶 `**` 嗰兩條係 wildcard，OAuth 跳返嚟時個網址通常帶住 `#access_token=…` 或者 query string，
> 淨係加冇 wildcard 嗰條會有機會俾 Supabase 拒絕。兩款都加齊最穩陣。
>
> **Site URL 一定要係 GitHub Pages 嗰條**（出街版先係主場）；`localhost:8000` 只係加落 Redirect URLs 做本機測試。

---

## 步驟 7／將 URL 同 key 貼入 index.html（1 分鐘）

1. Supabase 左下角 **Project Settings**（齒輪）→ **API Keys**
2. 抄低兩樣：
   - **Project URL**：`https://xxxxx.supabase.co`
   - **Publishable key**（舊名 **anon public**）：`sb_publishable_…` 或者一條好長嘅 `eyJ…`
3. 開 `index.html`，Ctrl+F 搵 `CONFIG`，填佢下面兩行：

```js
var SUPABASE_URL = 'https://xxxxx.supabase.co';
var SUPABASE_KEY = 'sb_publishable_...';
```

4. 存檔，push 上 GitHub（Pages 由 repo 根目錄出）

> 呢兩個 key **可以公開**，唔使收埋 —— 佢哋本身就係要俾瀏覽器攞到。
> 真正嘅防線係第 3 步落咗嘅 RLS policy：親友寫唔到、pending 睇唔到、未登入乜都掂唔到，
> 全部喺資料庫嗰層擋，唔喺瀏覽器。`tests/rls-test.mjs` 就係驗呢一層。

---

## 步驟 8／行起佢

**出街版**：直接開 https://kennethlaw325.github.io/home-supplies/（push 完等一兩分鐘 Pages rebuild）

**本機版**：喺 repo 資料夾㩒住 Shift + 右鍵 → **在終端中開啟**，打：

```powershell
python -m http.server 8000
```

> 話 `python` 唔係指令？改打 `py -m http.server 8000`。
> 兩個都唔得＝部機冇 Python，用 VS Code 個 Live Server 都得 —— 要嘅只係一條 `http://localhost:8000`。
> ⚠️ port 一定要係 **8000**，因為第 5、6 步就係咁寫死咗。

跟住開 http://localhost:8000

✅ **應該見到**：登入畫面（「要登入先睇到屋企盤數」）。
仲見到「backend 未接」＝第 7 步兩行未填齊。

---

## 步驟 9／測試 checklist

| # | 做乜 | 應該見到 |
|---|---|---|
| 1 | 撳「用 Google 登入」 | 跳去 Google 揀帳戶版面 |
| 2 | 揀你自己（`schema.sql` 入面嗰個 admin） | 跳返嚟，直接入到帳簿 |
| 3 | 望左上角 | 黑色 chip 寫 **管理人**，隔離係你個 email |
| 4 | 入一筆數（廁紙／買咗／10／45）撳「加入」 | 清單即刻出現「廁紙 仲剩 10」 |
| 5 | Supabase → **Table Editor** → `records` | 見到啱啱嗰筆，`created_by` 係你個 email |
| 6 | 登出，用**第二個 Google 帳戶**登入 | 見到「等緊批准」畫面 |
| 7 | 用返 admin 登入 → 撳「成員管理」 | 「等緊批准」見到啱啱嗰個 email |
| 8 | 揀「店員」→ 撳「批准」 | 佢跳落「現有成員」，顯示店員 |
| 9 | 用嗰個帳戶再登入 | 入到帳簿，chip 寫 **店員**，**冇**「成員管理」掣 |
| 10 | 切返 admin → 成員管理 → 將佢改做「**親友（唯讀）**」；返去嗰邊重新載入 | 入數表同「清空全部」消失，低量門檻格變咗 disabled，頂部有唯讀提示 |

> 💡 #6 到 #10 兩個帳戶要來回切。最順係一個正常視窗 + 一個無痕視窗各登入一個。

### 加碼：證明 RLS 真係擋到（唔止收埋個掣）

用**親友**帳戶登入，撳 F12 → Console，貼：

```js
await sb.from('records').insert({
  id: 'probe-1', name: '測試', kind: 'buy', qty: 1, amount: 1, date: '2026-08-13'
});
```

✅ **應該見到**：`error` 唔係 null，訊息含 `row-level security policy`。
權限唔喺瀏覽器，喺資料庫 —— 呢個就係成件事嘅重點。

---

## 撞板急救

| 症狀 | 點解 / 點救 |
|---|---|
| 開出嚟係「backend 未接」 | 第 7 步兩行未填（兩行都要有值，而且唔可以仲係 `PASTE_...`） |
| Google 話 `redirect_uri_mismatch` | 第 5 步 **Authorised redirect URIs** 貼錯咗 GitHub Pages / localhost。嗰格要貼 **Supabase 個 callback URL** |
| Google 話 `origin_mismatch` | 第 5 步 **Authorised JavaScript origins** 兩條 origin 未加齊（`https://kennethlaw325.github.io` 同 `http://localhost:8000`） |
| 認完 Google 之後白畫面／跳唔返 | 第 6b 步 Redirect URLs 未加齊（連帶 `**` 嗰兩條） |
| Google 話你未通過驗證 | 第 5 步 **Test users** 未加嗰個 email |
| 登入到但一直「等緊批准」 | `members` 入面冇你個 email，或者打錯字。Supabase → Table Editor → `members` 望下 |
| Console 見到 `infinite recursion detected` | `private.my_role()` 冇建成功。重跑成份 `schema.sql` —— ⚠️ **重跑會清走 records / thresholds / members**，跑之前先 Export CSV ＋ 抄低成員名單 |
| 入數話「你冇改呢盤數嘅權限」但你係管理人 | 你登入嗰個 email ≠ `members` 入面嗰個。對一對大細楷／有冇打錯 |
| 見到「呢個紀錄 id 用過咗」 | 正常防守：刪咗嘅紀錄唔准用返同一個 id 開返（防人偽造 `created_by`）。入新一筆就得 |

---

## 出街之前要知：Google 而家仲係 Testing mode

呢個 mode 之下，**只有第 5 步加咗做 Test user 嗰啲 email 入得嚟**。其他人撳「用 Google 登入」會俾 Google 直接擋，
連 app 個「等緊批准」畫面都見唔到。二揀一：

- **繼續 Testing（推薦，示範／屋企用）** —— 每加一個人就返 Google Cloud Console → OAuth consent screen → Audience → Test users 加佢個 email。上限 100 個。
- **Publish 個 OAuth app** —— Audience 頁撳 **Publish app**。任何 Google 帳戶都撳得入嚟排隊，但要應付 Google 嗰邊嘅 verification 要求（scope 淨係 email/profile 通常唔使人手審，但條款／私隱政策連結要填齊）。

即係話：「新人自動排隊」係**過咗 Google 呢一層之後**先開始。Google 白名單係第一道閘，app 個 `pending` 係第二道。
