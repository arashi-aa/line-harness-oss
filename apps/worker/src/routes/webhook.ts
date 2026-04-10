import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import type { Env } from '../index.js';

const webhook = new Hono<Env>();

webhook.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // Multi-account: resolve credentials from DB by destination (channel user ID)
  // or fall back to environment variables (default account)
  let channelSecret = c.env.LINE_CHANNEL_SECRET;
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;

  if ((body as { destination?: string }).destination) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelSecret = account.channel_secret;
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        break;
      }
    }
  }

  // Verify with resolved secret
  const valid = await verifySignature(channelSecret, rawBody, signature);
  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(
          db,
          lineClient,
          event,
          channelAccessToken,
          matchedAccountId,
          c.env.WORKER_URL || new URL(c.req.url).origin,
          c.env.SURVEY_SCENARIO_ID || DEFAULT_SURVEY_SCENARIO_ID,
          c.env.LIFF_URL,
          c.env.POKERHP_PAIR_API_URL,
          c.env.POKERHP_PAIR_API_TOKEN,
        );
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

// 「アンケート」キーワードで再開できるシナリオのデフォルトID
// （wrangler.toml の [vars] SURVEY_SCENARIO_ID で上書き可能）
const DEFAULT_SURVEY_SCENARIO_ID = '2e832c35-a090-468f-943f-1d98bd3b2db2';
const SURVEY_RESTART_KEYWORDS = ['アンケート', 'あんけーと', 'アンケート再開', 'survey', 'Survey', 'SURVEY'];
// Force-restart（完了済みでも強制的に Q1 から再送）するためのキーワード
const SURVEY_FORCE_RESTART_KEYWORDS = ['アンケート再回答', 'アンケートやり直し', 'アンケートリセット'];

/** サーベイ完了時におすすめ記事として案内する pokerHP の記事パス */
const SURVEY_REWARD_ARTICLE_PATH = '/learn/intermediate/akq-game';

/**
 * pokerHP /api/line/create-link-url を呼んで連携用 URL を取得する。
 * 失敗時は null を返す。
 * redirectPath を渡すと、ユーザーが URL をタップして /link に到達した後の
 * リダイレクト先に使われる（トークンに紐付けて保存される）。
 */
async function issueLinkUrl(
  messagingApiId: string,
  pairApiUrl: string,
  pairApiToken: string,
  redirectPath?: string,
): Promise<string | null> {
  try {
    // pairApiUrl は pokerHP の base URL（例: https://www.seekerstart.com/api/line）
    // 末尾が /pair などで終わっていれば除去してから /create-link-url を付ける
    const base = pairApiUrl.replace(/\/(pair|create-link-url)\/?$/, '').replace(/\/$/, '');
    const payload: Record<string, string> = { messagingApiId };
    if (redirectPath) payload.redirectPath = redirectPath;
    const res = await fetch(`${base}/create-link-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pairApiToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('[link-url] pokerHP returned non-OK:', res.status);
      return null;
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string };
    if (body.ok && body.url) return body.url;
    return null;
  } catch (err) {
    console.error('[link-url] fetch failed:', err);
    return null;
  }
}

/**
 * アンケート完了時に送信する「記事紹介文 + 連携URL」の統合メッセージ。
 * Harness Step 13（旧固定URL）を廃止したため、このメッセージが唯一の
 * 完了メッセージになる。
 */
function buildSurveyCompleteMessage(linkUrl: string): string {
  return (
    'アンケートへのご回答、ありがとうございます！\n\n' +
    '感謝の気持ちを込めて、アンケート回答者だけが読める限定記事を用意しました🎁\n\n' +
    '📖「AKQゲーム — ポーカーの本質を3枚で学ぶ」\n\n' +
    'たった3枚のカードで遊ぶ超シンプルなポーカーなのに、\n' +
    '・なぜブラフが必要なのか\n' +
    '・GTO戦略とexploit戦略の本質的な違い\n' +
    '・バリューベット・ブラフ・コールの最適な判断\n' +
    'がぜんぶ詰まっています。\n\n' +
    '↓ 下のリンクをタップすると自動で連携が完了して、そのまま記事が読めます✨\n\n' +
    `${linkUrl}\n\n` +
    '※リンクの有効期限は30分です\n' +
    '※リンクが切れた場合は「アンケート」と送信すれば再発行されます'
  );
}

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  surveyScenarioId: string = DEFAULT_SURVEY_SCENARIO_ID,
  liffUrl?: string,
  pokerhpPairApiUrl?: string,
  pokerhpPairApiToken?: string,
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    // Set line_account_id for multi-account tracking
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL')
        .bind(lineAccountId, friend.id).run();
    }

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    const scenarios = await getScenarios(db);
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          const existing = await db
            .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
            .bind(friend.id, scenario.id)
            .first<{ id: string }>();
          if (!existing) {
            const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);

            // Immediate delivery: if the first step has delay=0, send it now via replyMessage (free)
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
              try {
                const expandedContent = expandVariables(firstStep.message_content, friend as { id: string; display_name: string | null; user_id: string | null });
                const message = buildMessage(firstStep.message_type, expandedContent);
                await lineClient.replyMessage(event.replyToken, [message]);
                console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

                // Log outgoing message (replyMessage = 無料)
                const logId = crypto.randomUUID();
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', ?)`,
                  )
                  .bind(logId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
                  .run();

                // Advance or complete the friend_scenario
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                  nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
          }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // イベントバス発火: friend_add
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // Harness webhook 設定前に友だち追加していたユーザーは friends テーブルに
    // 行がない。初回メッセージ時点で LINE プロフィールを取得して upsert する
    // ことで、以降のロジック（キーワード応答・シナリオ進行・自動返信）が
    // 正常に動作するようにする。
    let friend = await getFriendByLineUserId(db, userId);
    if (!friend) {
      let profile;
      try {
        profile = await lineClient.getProfile(userId);
      } catch (err) {
        console.error('Failed to fetch profile for legacy friend', userId, err);
      }
      friend = await upsertFriend(db, {
        lineUserId: userId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      });
      if (lineAccountId) {
        await db
          .prepare('UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL')
          .bind(lineAccountId, friend.id)
          .run();
      }
    }

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    const trimmedText = incomingText.trim();

    // 「連携」キーワード: pokerHP /api/line/create-link-url を呼んで
    // 連携用 URL を発行し、ユーザーに返信する。ユーザーは URL をタップするだけで
    // LINE Login ID ↔ Messaging API ID のマッピングが作成される。
    const LINK_KEYWORDS = ['連携', 'れんけい', 'link', 'Link', 'LINK'];
    if (LINK_KEYWORDS.includes(trimmedText) && pokerhpPairApiUrl && pokerhpPairApiToken) {
      try {
        const linkUrl = await issueLinkUrl(friend.line_user_id, pokerhpPairApiUrl, pokerhpPairApiToken);
        const replyText = linkUrl
          ? `下のリンクをタップすると、Seeker Start のゲート記事がすぐ読めるようになります👇\n\n${linkUrl}\n\n※有効期限は30分です`
          : '連携サーバーと通信できませんでした。時間を置いてもう一度お試しください。';

        await lineClient.replyMessage(event.replyToken, [buildMessage('text', replyText)]);

        const outLogId = crypto.randomUUID();
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
             VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', ?)`,
          )
          .bind(outLogId, friend.id, replyText, jstNow())
          .run();
      } catch (err) {
        console.error('Failed to send link URL:', err);
      }
      return;
    }

    // 「アンケート」キーワード:
    // - 既に回答完了しているユーザー → Q1〜Q12 を再送せず、連携 URL だけ返す
    // - 未回答のユーザー → friend_scenarios を削除して再エンロール、Q1 を即時返信
    // 「アンケート再回答」等の強制再回答キーワードは完了済みでも必ず Q1 から再送する
    const isForceRestart = SURVEY_FORCE_RESTART_KEYWORDS.includes(trimmedText);
    if (SURVEY_RESTART_KEYWORDS.includes(trimmedText) || isForceRestart) {
      // 既に完了済みかチェック（force restart なら飛ばす）
      const completedRow = isForceRestart
        ? null
        : await db
        .prepare(
          `SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ? AND status = 'completed' LIMIT 1`,
        )
        .bind(friend.id, surveyScenarioId)
        .first<{ id: string }>();

      if (completedRow && pokerhpPairApiUrl && pokerhpPairApiToken) {
        // 既回答ユーザー: 連携 URL のみを送る
        try {
          const linkUrl = await issueLinkUrl(
            friend.line_user_id,
            pokerhpPairApiUrl,
            pokerhpPairApiToken,
            SURVEY_REWARD_ARTICLE_PATH,
          );
          const replyText = linkUrl
            ? `既にアンケートにご回答いただいているので、下のリンクをタップすれば Seeker Start の記事がすぐ読めます👇\n\n${linkUrl}\n\n※有効期限は30分です\n※再回答したい場合は「アンケート再回答」と送信してください`
            : '連携サーバーと通信できませんでした。時間を置いてもう一度お試しください。';

          await lineClient.replyMessage(event.replyToken, [buildMessage('text', replyText)]);

          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
               VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', ?)`,
            )
            .bind(outLogId, friend.id, replyText, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send survey-already-completed link:', err);
        }
        return;
      }

      try {
        // 未回答（または強制再回答キーワード）→ 既存行を全削除して再エンロール
        await db
          .prepare(`DELETE FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friend.id, surveyScenarioId)
          .run();

        // 再エンロール
        const friendScenario = await enrollFriendInScenario(db, friend.id, surveyScenarioId);

        // Q1 を即座に replyMessage で返信（無料、quota消費なし）
        const steps = await getScenarioSteps(db, surveyScenarioId);
        const firstStep = steps[0];
        if (firstStep) {
          const expandedContent = expandVariables(
            firstStep.message_content,
            friend as { id: string; display_name: string | null; user_id: string | null },
            workerUrl,
          );
          const replyMsg = buildMessage(firstStep.message_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);

          // 送信ログ
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', ?)`,
            )
            .bind(outLogId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
            .run();

          // 進行状態を更新（次のステップがあれば next_delivery_at をセット、なければ完了）
          const secondStep = steps[1] ?? null;
          if (secondStep) {
            const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
            nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
            await advanceFriendScenario(
              db,
              friendScenario.id,
              firstStep.step_order,
              nextDeliveryDate.toISOString().slice(0, -1) + '+09:00',
            );
          } else {
            await completeFriendScenario(db, friendScenario.id);
          }
        }
      } catch (err) {
        console.error('Failed to restart survey scenario via keyword:', err);
      }
      return; // 早期return: 他のハンドラ（チャット更新・自動返信・既存シナリオ進行）はスキップ
    }

    // チャットを作成/更新（ユーザーの自発的メッセージのみ unread にする）
    // ボタンタップ等の自動応答キーワードは除外
    const autoKeywords = ['料金', '機能', 'API', 'フォーム', 'ヘルプ', 'UUID', 'UUID連携について教えて', 'UUID連携を確認', '配信時間', '導入支援を希望します', 'アカウント連携を見る', '体験を完了する', 'BAN対策を見る', '連携確認'];
    const isAutoKeyword = autoKeywords.some(k => incomingText === k);
    const isTimeCommand = /(?:配信時間|配信|届けて|通知)[はを]?\s*\d{1,2}\s*時/.test(incomingText);
    if (!isAutoKeyword && !isTimeCommand) {
      await upsertChatOnMessage(db, friend.id);
    }

    // 配信時間設定: 「配信時間は○時」「○時に届けて」等のパターンを検出
    const timeMatch = incomingText.match(/(?:配信時間|配信|届けて|通知)[はを]?\s*(\d{1,2})\s*時/);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1], 10);
      if (hour >= 6 && hour <= 22) {
        // Save preferred_hour to friend metadata
        const existing = await db.prepare('SELECT metadata FROM friends WHERE id = ?').bind(friend.id).first<{ metadata: string }>();
        const meta = JSON.parse(existing?.metadata || '{}');
        meta.preferred_hour = hour;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), jstNow(), friend.id).run();

        // Reply with confirmation
        try {
          const period = hour < 12 ? '午前' : '午後';
          const displayHour = hour <= 12 ? hour : hour - 12;
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '配信時間を設定しました', size: 'lg', weight: 'bold', color: '#1e293b' },
                { type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: `${period} ${displayHour}:00`, size: 'xxl', weight: 'bold', color: '#f59e0b', align: 'center' },
                  { type: 'text', text: `（${hour}:00〜）`, size: 'sm', color: '#64748b', align: 'center', margin: 'sm' },
                ], backgroundColor: '#fffbeb', cornerRadius: 'md', paddingAll: '20px', margin: 'lg' },
                { type: 'text', text: '今後のステップ配信はこの時間以降にお届けします。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
              ], paddingAll: '20px' },
            })),
          ]);
        } catch (err) {
          console.error('Failed to reply for time setting', err);
        }
        return;
      }
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // シナリオ即時配信: アクティブなシナリオがあれば回答後すぐに次のステップを送る
    const activeScenarios = await db
      .prepare(`SELECT fs.id, fs.scenario_id, fs.current_step_order, fs.status FROM friend_scenarios fs WHERE fs.friend_id = ? AND fs.status = 'active'`)
      .bind(friend.id)
      .all<{ id: string; scenario_id: string; current_step_order: number; status: string }>();

    for (const fs of activeScenarios.results) {
      try {
        const steps = await getScenarioSteps(db, fs.scenario_id);
        const nextStep = steps.find((s) => s.step_order > fs.current_step_order);
        if (!nextStep) {
          await completeFriendScenario(db, fs.id);
          continue;
        }

        // Send next step immediately via pushMessage
        const expandedContent = expandVariables(nextStep.message_content, friend as { id: string; display_name: string | null; user_id: string | null }, workerUrl);
        const message = buildMessage(nextStep.message_type, expandedContent);
        await lineClient.pushMessage(friend.line_user_id, [message]);

        // Log outgoing message
        const outLogId = crypto.randomUUID();
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'push', ?)`,
          )
          .bind(outLogId, friend.id, nextStep.message_type, nextStep.message_content, nextStep.id, jstNow())
          .run();

        // Advance or complete
        const nextIndex = steps.indexOf(nextStep) + 1;
        const followingStep = nextIndex < steps.length ? steps[nextIndex] : null;
        if (followingStep) {
          const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
          nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + followingStep.delay_minutes);
          await advanceFriendScenario(db, fs.id, nextStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
        } else {
          await completeFriendScenario(db, fs.id);

          // サーベイシナリオが完了したタイミングで、記事紹介文 + 連携 URL を 1 通で送信する。
          // Step 13（固定 URL の旧完了メッセージ）は D1 migration 012 で削除済み。
          if (fs.scenario_id === surveyScenarioId && pokerhpPairApiUrl && pokerhpPairApiToken) {
            try {
              const linkUrl = await issueLinkUrl(
                friend.line_user_id,
                pokerhpPairApiUrl,
                pokerhpPairApiToken,
                SURVEY_REWARD_ARTICLE_PATH,
              );
              const linkMsg = linkUrl
                ? buildSurveyCompleteMessage(linkUrl)
                : 'アンケートへのご回答、ありがとうございます！\n記事リンクの発行に一時的に失敗しました。少し後に「アンケート」と送信してください。';
              await lineClient.pushMessage(friend.line_user_id, [buildMessage('text', linkMsg)]);

              const linkLogId = crypto.randomUUID();
              await db
                .prepare(
                  `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
                   VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', ?)`,
                )
                .bind(linkLogId, friend.id, linkMsg, jstNow())
                .run();
            } catch (err) {
              console.error('Failed to send post-survey link URL:', err);
            }
          }
        }
      } catch (err) {
        console.error('Failed immediate scenario delivery on message:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplies = await db
      .prepare(`SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL${lineAccountId ? ` OR line_account_id = '${lineAccountId}'` : ''}) ORDER BY created_at ASC`)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        try {
          // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}})
          const expandedContent = expandVariables(rule.response_content, friend as { id: string; display_name: string | null; user_id: string | null }, workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);

          // 送信ログ（replyMessage = 無料）
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', ?)`,
            )
            .bind(outLogId, friend.id, rule.response_type, rule.response_content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
        }

        matched = true;
        break;
      }
    }

    // イベントバス発火: message_received
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
    }, lineAccessToken, lineAccountId);

    return;
  }
}

export { webhook };
