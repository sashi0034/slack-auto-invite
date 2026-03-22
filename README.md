# Slack Auto Invite Bot

指定されたプレフィックス（例: `#2026-`）で始まる全チャンネルへ、ユーザーを自動で一括招待する Slack Bot です。

## 機能

1.  **手動招待**: 起動時に送信されるボタンを押したユーザーを一括招待します。
2.  **自動招待**: 特定の指定チャンネル（`triggerChannelId`）に参加したユーザーを、既存の対象チャンネルに自動で招待します。
3.  **新規チャンネル招待**: `#2026-` で始まる新しいチャンネルが作成された際、`triggerChannelId` のメンバー全員をそのチャンネルに自動で招待します。

## セットアップ

### 1. Slack App の設定 (Slack API)

Slack App の管理画面 ([api.slack.com/apps](https://api.slack.com/apps)) にて、以下の設定を行ってください。

#### **OAuth & Permissions (Scopes)**
**Bot Token Scopes** に以下の権限を追加してください：
*   `channels:read`: チャンネル一覧の取得に使用。
*   `channels:join`: 新しいチャンネルが作成された際に自動で参加するために必要。
*   `channels:manage`: ユーザーを公開チャンネルに招待するために必要。
*   `chat:write`: メッセージや実行結果の送信、およびログ出力に使用。

#### **Event Subscriptions**
1.  **Enable Events** を `On` にします。
2.  **Subscribe to bot events** に以下を追加します：
    *   `member_joined_channel`: 指定チャンネルへの参加を検知するために必要。
    *   `channel_created`: 新しいチャンネルの作成を検知するために必要。

#### **Socket Mode**
1.  **Enable Socket Mode** を `On` に設定し、`App Level Token` を生成してください（`connections:write` 権限が含まれます）。

---

### 2. ローカル環境の設定

1.  リポジトリのルートに `secret-config.json` を作成（`.gitignore` 済み）し、以下の内容を記入します：
    ```json
    {
      "botToken": "xoxb-...",        // Bot User OAuth Token
      "appToken": "xapp-...",        // App Level Token (Socket Mode)
      "appId": "...",                // Slack App の App ID
      "startupChannelId": "...",     // 起動メッセージを送信するチャンネルID
      "triggerChannelId": "..."      // 自動招待のトリガーとなるチャンネルID
    }
    ```

2.  依存関係のインストール：
    ```bash
    npm install
    ```

### 3. 実行

開発モード（ts-node）で起動する：
```bash
npm run dev
```

---

## 補足
*   エラーハンドリング: 既にチャンネルに参加しているユーザーを招待しても、エラーとして処理を中断せず、他のチャンネルへの招待を続行します。
*   対象チャンネル: `src/index.ts` の `TARGET_CHANNEL_PREFIX` (デフォルト: `#2026-`) を変更することで、対象外のチャンネルを指定できます。
*   チャンネルリストの取得: `conversations.list` を使用し、ページネーションを含めてすべての公開チャンネルを検索します。
