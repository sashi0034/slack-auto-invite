# 🚀 Slack Auto Invite Bot

指定されたプレフィックス（デフォルト: `#2026-`）で始まる全チャンネルへ、ユーザーを自動で一括招待するパワフルな Slack Bot です。

## ✨ 主な機能

この Bot は以下の 4 つの強力な自動化機能を提供します。

1. **🔘 手動一括招待 (ボタン)**
   ボット起動時に送信されるメッセージのボタンを押すだけで、対象の全チャンネルへ自分自身を招待できます。

2. **⚡ 自動招待 (チャンネル参加時)**
   指定された「トリガーチャンネル」に参加したユーザーを、既存のすべての対象チャンネルへ自動的に招待します。

3. **🆕 新規チャンネルへの自動招待**
   対象プレフィックスで始まる新しいチャンネルが作成された際、トリガーチャンネルのメンバー全員をそのチャンネルへ即座に招待します。

4. **🔄 定期ラウンドロビン招待**
   5分ごとに1つの対象チャンネルをピックアップし、トリガーチャンネルのメンバー全員を招待します。これにより、API の負荷を抑えつつ、着実に全メンバーを全チャンネルへ網羅します。

---

## 🛠️ セットアップ

### 1. Slack App の構成

[Slack API 管理画面](https://api.slack.com/apps)でアプリを作成し、以下の設定を行ってください。

#### **Scopes (Bot Token Scopes)**
*   `channels:read` - チャンネル一覧の取得
*   `channels:join` - 新規チャンネルへの自動参加
*   `channels:manage` - ユーザーの招待
*   `chat:write` - 起動メッセージの送信

#### **Events (Bot Events)**
*   `member_joined_channel` - 指定チャンネルへの参加検知
*   `channel_created` - 新規チャンネル作成の検知

#### **Socket Mode**
*   `Enable Socket Mode` を **On** に設定。
*   App Level Token (`connections:write` 権限) を生成。

---

## ⚙️ 環境設定

リポジトリのルートに `secret-config.json` を作成し、以下の形式で設定を記述します。

```json
{
  "botToken": "xoxb-...",        // Bot User OAuth Token
  "userToken": "xoxp-...",        // User OAuth Token (招待権限を持つユーザーのもの)
  "appToken": "xapp-...",        // App Level Token
  "appId": "...",                // App ID
  "startupChannelId": "...",     // 起動メッセージ送信先 ID
  "triggerChannelId": "..."      // 自動招待の基準となるチャンネルID
}
```

---

## 🚀 実行方法

依存関係をインストールして起動します。

```bash
# インストール
npm install

# 開発モードで実行
npm run dev
```

---

## 💡 テクニカルメモ

*   **Prefix 設定**: `src/index.ts` の `TARGET_CHANNEL_PREFIX` で対象チャンネルを自由に変更可能です。
*   **Rate Limit 対策**: Slack API の制限を考慮し、一括招待が失敗した場合は 300ms 間隔の個別招待に自動で切り替わります。
*   **堅牢なエラーハンドリング**: すでに参加済みのユーザーがいても、処理を止めることなく次の招待を続行します。
