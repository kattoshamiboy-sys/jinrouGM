# NextGen Werewolf — Firebase 対応版 セットアップガイド

## 必要なもの

- Firebase プロジェクト（無料の Spark プランで動作します）
- Node.js（Firebase CLI のインストールに必要）
- Cloudflare アカウント（CDN + ドメイン管理用）

---

## Step 1：Firebase プロジェクトを作成する

1. [Firebase Console](https://console.firebase.google.com/) を開く
2. 「プロジェクトを追加」→ プロジェクト名を入力（例：`werewolf-game`）
3. Google アナリティクスは任意（オフでも可）

---

## Step 2：Realtime Database を有効にする

1. 左メニュー「構築」→「Realtime Database」→「データベースを作成」
2. ロケーションは **asia-southeast1（シンガポール）** を推奨（日本から最速）
3. セキュリティルールは「**テストモードで開始**」を選択（後で上書きします）

---

## Step 3：アプリの設定値を取得して app.js に書き込む

1. Firebase Console 左上の歯車アイコン →「プロジェクトの設定」
2. 「マイアプリ」セクション →「</> ウェブ」アイコンでアプリを登録
3. 表示される `firebaseConfig` の値をコピーして、`app.js` の先頭部分に貼り付ける

```javascript
// app.js の先頭（ここを書き換えてください）
const firebaseConfig = {
  apiKey:            "AIzaSy...",          // ← ここに貼る
  authDomain:        "your-project.firebaseapp.com",
  databaseURL:       "https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "your-project-id",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc..."
};
```

> ⚠️ `databaseURL` は必ず入力してください。抜けると Realtime Database に接続できません。
> アジアリージョンの場合は `asia-southeast1` が URL に含まれます。

---

## Step 4：セキュリティルールを適用する

Firebase Console の「Realtime Database」→「ルール」タブを開き、
`database.rules.json` の内容をそのまま貼り付けて「公開」ボタンを押してください。

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true
      }
    },
    "$other": {
      ".read": false,
      ".write": false
    }
  }
}
```

> 現在のルールは「全員が rooms 以下を読み書きできる」オープンな設定です。
> 身内で使う分にはこれで問題ありません。

---

## Step 5：Firebase CLI でデプロイする

```bash
# Firebase CLI のインストール（初回のみ）
npm install -g firebase-tools

# ログイン
firebase login

# プロジェクトを紐付け（your-project-id を実際のIDに変更）
firebase use your-project-id

# デプロイ
firebase deploy --only hosting
```

デプロイ完了後、`https://your-project-id.web.app` でアクセスできます。

---

## Step 6：Cloudflare でカスタムドメインを設定する（任意）

1. Firebase Console「ホスティング」→「カスタムドメインを追加」
2. 使用したいドメインを入力
3. Cloudflare の DNS 設定で表示された CNAME / A レコードを追加
4. Cloudflare の「プロキシ」（オレンジ雲マーク）を **有効のまま** にしてOK
   - Firebase の SSL と Cloudflare の SSL が二重になるが正常に動作します

---

## 動作確認チェックリスト

- [ ] `app.js` の `firebaseConfig` を自分のプロジェクトの値に書き換えた
- [ ] Firebase Console で Realtime Database を作成した
- [ ] `databaseURL` が正しく設定されている（`https://...firebasedatabase.app`）
- [ ] セキュリティルールを適用した
- [ ] Firebase Hosting にデプロイした
- [ ] 2つの異なるスマートフォンで同じURLを開き、ルームIDを共有してゲームが同期されることを確認した

---

## よくあるエラー

| エラー | 原因 | 対処 |
|---|---|---|
| `FIREBASE FATAL ERROR: Can't determine Firebase Database URL` | `databaseURL` が未設定 | app.js の firebaseConfig に `databaseURL` を追加 |
| ゲームが同期されない | 別オリジン（localhost vs 本番）でテストしている | 同じURLでアクセスする |
| `Permission denied` | セキュリティルールが古いまま | Realtime Database のルールを更新する |
| 接続エラーのトースト表示 | Firebase プロジェクト未作成・設定値の誤り | firebaseConfig を再確認 |

---

## ファイル構成

```
├── index.html          # メインHTML（Firebase SDK のscriptタグ追加済み）
├── app.js              # ゲームロジック（localStorage → Firebase Realtime DB に移行済み）
├── style.css           # スタイル（変更なし）
├── firebase.json       # Firebase Hosting の設定
├── database.rules.json # Realtime Database セキュリティルール
└── README_firebase設定.md  # このファイル
```
