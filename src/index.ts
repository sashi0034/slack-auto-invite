import { App, LogLevel } from "@slack/bolt";
import * as dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";
import cron from "node-cron";

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
    userToken: jsonConfig.userToken || process.env.SLACK_USER_TOKEN,
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

    const config = await loadConfig();
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
          }
        }

        // ユーザーを招待する
        try {
          // 自分自身を招待しようとするとエラーになるため、可能であれば ID を確認する
          // (ここでは userId が自分かどうかを直接判定できないため、try-catch で対応)
          return await getApp().client.conversations.invite({
            token: config.userToken || config.botToken,
            channel: target.id,
            users: userId,
          });
        } catch (inviteError: any) {
          const errorMsg = inviteError.data?.error || inviteError.message;
          if (errorMsg === "already_in_channel" || errorMsg === "cant_invite_self") {
            return { ok: true };
          }
          throw inviteError;
        }
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
    // const config = await loadConfig(); // この行を削除（関数の最初で取得済み）
    if (config.triggerChannelId) {
      let logMessage = `${userId} の招待処理が完了しました。\n成功: ${successCount} チャンネル / 失敗: ${failCount} チャンネル`;
      if (failCount > 0) {
        logMessage += `\n失敗したチャンネル: ${errors.join(", ")}`;
      }
      await getApp().client.chat.postMessage({
        channel: config.triggerChannelId,
        text: logMessage,
      });
    }

    console.log(`Invited user ${userId} to ${successCount} channels (failed: ${failCount}).`);

  } catch (error) {
    console.error("Unexpected error in invite process:", error);
  }
}

/**
 * チャンネルのメンバー一覧を取得する
 */
async function getChannelMembers(channelId: string): Promise<string[]> {
  const members: string[] = [];
  try {
    let cursor: string | undefined;
    do {
      const result = await getApp().client.conversations.members({
        channel: channelId,
        cursor: cursor,
        limit: 1000,
      });
      if (result.members) {
        members.push(...result.members);
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  } catch (error) {
    console.error(`Error fetching members for channel ${channelId}:`, error);
  }
  return members;
}

/**
 * 複数のユーザーを一つのチャンネルに招待する
 */
async function inviteUsersToChannel(channelId: string, userIds: string[], customMessage?: string, disableLog = false): Promise<number> {
  if (userIds.length === 0) return 0;

  // ボットがチャンネルに参加
  try {
    await getApp().client.conversations.join({ channel: channelId });
  } catch (error: any) {
    console.error(`Failed to join channel ${channelId}:`, error.data?.error || error.message);
  }

  // 招待処理
  const config = await loadConfig();
  const chunkSize = 500;
  let actuallyInvitedCount = 0;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    try {
      await getApp().client.conversations.invite({
        token: config.userToken || config.botToken,
        channel: channelId,
        users: chunk.join(","),
      });
      console.log(`Successfully invited ${chunk.length} users to channel ${channelId}`);
      actuallyInvitedCount += chunk.length;
    } catch (error: any) {
      const errorMsg = error.data?.error || error.message;
      // cant_invite_self や already_in_channel の場合は個別に処理
      if (errorMsg === "already_in_channel" || errorMsg === "cant_invite_self" || errorMsg === "invalid_arguments") {
        for (const userId of chunk) {
          try {
            await getApp().client.conversations.invite({
              token: config.userToken || config.botToken,
              channel: channelId,
              users: userId,
            });
            actuallyInvitedCount++;
          } catch (individualError: any) {
            const indErrorMsg = individualError.data?.error || individualError.message;
            if (indErrorMsg !== "already_in_channel" && indErrorMsg !== "cant_invite_self") {
              console.error(`Failed to invite user ${userId} to ${channelId}:`, indErrorMsg);
            }
          }
        }
      } else {
        console.error(`Failed to invite chunk to ${channelId}:`, errorMsg);
      }
    }
  }

  // ログ送信
  if (!disableLog && config.triggerChannelId && actuallyInvitedCount > 0) {
    await getApp().client.chat.postMessage({
      channel: config.triggerChannelId,
      text: customMessage ? customMessage.replace("{count}", actuallyInvitedCount.toString()) : `新しく作成されたチャンネル <#${channelId}> に、指定チャンネルのメンバー（${actuallyInvitedCount}名）を新たに招待しました。`,
    });
  }

  return actuallyInvitedCount;
}

/**
 * 起動時や定期チェック時に triggerChannelId の全ユーザーを対象チャンネルに招待する
 */
async function inviteStartupUsersToTargetChannels(isCron = false) {
  try {
    const config = await loadConfig();
    const triggerChannelId = config.triggerChannelId;
    if (!triggerChannelId) return;

    console.log(`Checking members of trigger channel: ${triggerChannelId}`);
    const triggerMembers = await getChannelMembers(triggerChannelId);
    if (triggerMembers.length === 0) {
      console.log("No members found in trigger channel.");
      return;
    }

    // 招待主（userToken の持ち主）の ID を取得して除外する
    let inviterId: string | undefined;
    if (config.userToken) {
      try {
        const authTest = await getApp().client.auth.test({ token: config.userToken });
        inviterId = authTest.user_id;
      } catch (e) {
        console.warn("Failed to fetch userToken owner info.");
      }
    }

    const filteredMembers = inviterId ? triggerMembers.filter(id => id !== inviterId) : triggerMembers;

    const targetChannels = await getTargetChannels();
    if (targetChannels.length === 0) {
      console.log("No target channels found matching prefix.");
      return;
    }

    console.log(`Starting bulk invite: ${filteredMembers.length} users (filtered from ${triggerMembers.length}) to ${targetChannels.length} channels.`);
    const prefix = isCron ? "定期チェック" : "起動時処理";
    
    let actuallyInvitedChannelsCount = 0;
    for (const target of targetChannels) {
      const invitedCount = await inviteUsersToChannel(target.id, filteredMembers, undefined, true);
      if (invitedCount > 0) {
        actuallyInvitedChannelsCount++;
      }
    }

    if (actuallyInvitedChannelsCount > 0) {
      await getApp().client.chat.postMessage({
        channel: triggerChannelId,
        text: `${prefix}: ${actuallyInvitedChannelsCount}個のチャンネル に、指定チャンネルのメンバー ${filteredMembers.length} 名の招待を実行しました。`,
      });
    }

    console.log("Startup/Cron bulk invite process completed.");
  } catch (error) {
    console.error("Error in inviteStartupUsersToTargetChannels:", error);
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
            text: `*下のボタンを押して、新しいチャンネルに参加しましょう！*`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: TARGET_CHANNEL_PREFIX + " に参加する",
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

    // 新しいチャンネル作成イベントの登録
    app.event("channel_created", async ({ event }) => {
      const channelNameWithHash = `#${event.channel.name}`;
      if (channelNameWithHash.startsWith(TARGET_CHANNEL_PREFIX)) {
        console.log(`New target channel created: ${event.channel.name} (${event.channel.id})`);
        const config = await loadConfig();
        if (config.triggerChannelId) {
          // 少し待ってから実行（チャンネル作成直後だと API が不安定な場合があるため）
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const members = await getChannelMembers(config.triggerChannelId);
          // 作成者を除外（既にチャンネルにいるため。除外しないと invite がエラーになる場合がある）
          const membersToInvite = members.filter(m => m !== event.channel.creator);
          
          await inviteUsersToChannel(event.channel.id, membersToInvite);
        }
      }
    });

    const port = Number(process.env.PORT) || 3000;
    await app.start(port);
    console.log(`⚡️ Bolt app is running on port ${port}!`);

    // 起動メッセージ送信
    await sendStartupMessage();

    // 起動時に既存ユーザーを一括招待
    await inviteStartupUsersToTargetChannels();

    // 毎日20:00に定期チェック
    cron.schedule("0 20 * * *", () => {
      console.log("Running daily check at 20:00...");
      inviteStartupUsersToTargetChannels(true);
    }, {
      timezone: "Asia/Tokyo"
    });

  } catch (error) {
    console.error("Error starting app:", error);
    process.exit(1);
  }
})();
