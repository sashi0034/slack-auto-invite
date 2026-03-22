import { App, LogLevel } from "@slack/bolt";
import * as dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";

dotenv.config();

/**
 * 予期せぬエラーによるプロセス停止を防ぐ
 */
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

/**
 * 設定（secret-config.json または 環境変数）を読み込む
 */
async function loadConfig() {
  let jsonConfig: any = {};
  try {
    const configPath = path.resolve(process.cwd(), "secret-config.json");
    const jsonStr = await fs.readFile(configPath, "utf-8");
    jsonConfig = JSON.parse(jsonStr);
  } catch (e) {
    // ファイルがない場合は無視
  }

  return {
    botToken: jsonConfig.botToken || process.env.SLACK_BOT_TOKEN,
    appToken: jsonConfig.appToken || process.env.SLACK_APP_TOKEN,
    appId: jsonConfig.appId || process.env.SLACK_APP_ID,
    startupChannelId: jsonConfig.startupChannelId || process.env.SLACK_STARTUP_CHANNEL_ID,
    triggerChannelId: jsonConfig.triggerChannelId || process.env.SLACK_TRIGGER_CHANNEL_ID,
  };
}

// 最初の設定読み込み（トップレベルの非同期は Bolt の外で行うか、初期化の中で行う）
// ここでは、app インスタンス作成のために、環境変数 または 固定のプレフィックスなどを定義
const TARGET_CHANNEL_PREFIX = "#2026-";

// アプリのインスタンス
let app: App;

function getApp(): App {
  if (!app) {
    throw new Error("App is not initialized yet.");
  }
  return app;
}

/**
 * チャンネル一覧を取得し、指定のプレフィックスに一致する公開チャンネルの情報を取得する
 */
async function getTargetChannels() {
  const targetChannels: { id: string; name: string; isMember: boolean }[] = [];
  try {
    let cursor: string | undefined;

    do {
      const options: any = {
        types: "public_channel",
        exclude_archived: true,
        limit: 1000,
      };
      if (cursor) {
        options.cursor = cursor;
      }
      const result = await getApp().client.conversations.list(options);

      if (result.channels) {
        for (const channel of result.channels) {
          const nameWithHash = `#${channel.name}`;
          if (channel.name && nameWithHash.startsWith(TARGET_CHANNEL_PREFIX)) {
            if (channel.id) {
              targetChannels.push({
                id: channel.id,
                name: channel.name,
                isMember: !!channel.is_member,
              });
            }
          }
        }
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

  } catch (error) {
    console.error("Error fetching channels:", error);
  }
  return targetChannels;
}

/**
 * 指定のユーザーを全対象チャンネルに招待する
 */
async function inviteUserToTargetChannels(userId: string, channelIdForNotification?: string) {
  try {
    const targetChannels = await getTargetChannels();
    
    if (targetChannels.length === 0) {
      if (channelIdForNotification) {
        await getApp().client.chat.postEphemeral({
          channel: channelIdForNotification,
          user: userId,
          text: `「${TARGET_CHANNEL_PREFIX}」で始まるチャンネルが見つかりませんでした。`,
        });
      }
      return;
    }

    const results = await Promise.allSettled(
      targetChannels.map(async (target) => {
        // ボット自身がチャンネルに入っていない場合は、まず参加する
        if (!target.isMember) {
          try {
            await getApp().client.conversations.join({
              channel: target.id,
            });
          } catch (joinError: any) {
            console.error(`Failed to join channel ${target.name} (${target.id}):`, joinError.data?.error || joinError.message);
            // 参加に失敗しても、招待を試みる（権限によっては招待できる可能性もゼロではないため、または別のエラーかもしれないため）
          }
        }

        // ユーザーを招待する
        return getApp().client.conversations.invite({
          channel: target.id,
          users: userId,
        });
      })
    );

    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];

    results.forEach((res, index) => {
      const target = targetChannels[index];
      if (!target) return; // TypeScript safety: lengths always match in reality

      if (res.status === "fulfilled") {
        successCount++;
      } else {
        const error = res.reason as any;
        const errorMsg = error.data?.error || error.message;
        
        if (errorMsg === "already_in_channel") {
          successCount++;
        } else {
          console.error(`Invite failed for channel ${target.name} (${target.id}):`, errorMsg);
          errors.push(`${target.name}: ${errorMsg}`);
          failCount++;
        }
      }
    });

    if (channelIdForNotification) {
      let message = `${successCount} 個のチャンネルに招待しました（失敗: ${failCount}）。`;
      if (failCount > 0) {
        message += `\n失敗したチャンネル: ${errors.join(", ")}`;
      }
      await getApp().client.chat.postEphemeral({
        channel: channelIdForNotification,
        user: userId,
        text: message,
      });
    }
    console.log(`Invited user ${userId} to ${successCount} channels (failed: ${failCount}).`);

  } catch (error) {
    console.error("Unexpected error in invite process:", error);
  }
}

/**
 * ボタン押しアクションのリスナー
 */


/**
 * 起動時にメッセージを送信する
 */
async function sendStartupMessage() {
  try {
    // 設定を再読み込み（または受け取ったものを使用）
    const config = await loadConfig();
    const channelId = config.startupChannelId;
    
    if (!channelId) {
      console.warn("Startup Channel ID not found in secret-config.json or environment variables. Skipping startup message.");
      return;
    }

    await getApp().client.chat.postMessage({
      channel: channelId,
      text: `ボットが起動しました。以下のボタンを押すと、「${TARGET_CHANNEL_PREFIX}」から始まる全チャンネルにあなたを招待します。`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*ボットが起動しました。*\n下のボタンを押して、対象のチャンネルに一括参加しましょう！`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "一括招待をリクエスト",
              },
              action_id: "invite_me_button",
              style: "primary",
            },
          ],
        },
      ],
    });
    console.log("Startup message sent.");
  } catch (error) {
    console.error("Error sending startup message:", error);
  }
}

(async () => {
  try {
    const config = await loadConfig();

    if (!config.botToken || !config.appToken) {
      throw new Error("SLACK_BOT_TOKEN or SLACK_APP_TOKEN is missing (secret-config.json or env).");
    }

    app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    // ボタン押しアクションの登録
    app.action("invite_me_button", async ({ ack, body }) => {
      await ack();
      await inviteUserToTargetChannels(body.user.id, body.channel?.id);
    });

    // チャンネル参加イベントの登録
    app.event("member_joined_channel", async ({ event }) => {
      const config = await loadConfig(); // 設定の再読み込み
      if (event.channel === config.triggerChannelId) {
        console.log(`User ${event.user} joined trigger channel ${event.channel}. Starting auto-invite...`);
        await inviteUserToTargetChannels(event.user);
      }
    });

    const port = Number(process.env.PORT) || 3000;
    await app.start(port);
    console.log(`⚡️ Bolt app is running on port ${port}!`);

    // 起動メッセージ送信
    await sendStartupMessage();
  } catch (error) {
    console.error("Error starting app:", error);
    process.exit(1);
  }
})();
