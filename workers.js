/**
 * Telegram 双向机器人 (Cloudflare Worker 实现)
 * 核心功能：
 * 1. 双向消息转发：用户私聊 ↔ 超级群组话题（文本/媒体）
 * 2. 编辑消息表情：🦄（1秒）→ 🕊，普通消息直接显示🕊
 * 3. 话题自动重建：检测到话题被删除时自动清理旧记录并重建（核心修复）
 * 4. Turnstile验证：人机验证后才能发送消息
 * 5. 管理员指令：用户信息/验证重置/封禁/有效期设置等
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 1. Turnstile验证处理
      if (path === "/turnstile-verify") {
        return await handleTurnstileVerify(request, env);
      }

      // 2. Telegram Webhook处理
      if (path === "/" && request.method === "POST") {
        return await handleTelegramWebhook(request, env, ctx);
      }

      // 3. 健康检查
      if (path === "/health" && request.method === "GET") {
        return new Response(JSON.stringify({
          status: "ok",
          timestamp: Date.now(),
          env_check: {
            bot_token: env.BOT_TOKEN ? "配置完成" : "缺失",
            supergroup_id: env.SUPERGROUP_ID ? "配置完成" : "缺失",
            turnstile: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? "配置完成" : "缺失",
            worker_domain: env.WORKER_DOMAIN ? "配置完成" : "缺失"
          }
        }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
      }

      return new Response("404 Not Found", { status: 404 });

    } catch (error) {
      console.error("[全局错误]", error.stack || error.message);
      return new Response("服务器内部错误", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  }
};

// ---------------- 核心：Telegram Webhook处理 ----------------
async function handleTelegramWebhook(request, env, ctx) {
  try {
    const requestBody = await request.text();
    let update = {};
    
    try {
      update = JSON.parse(requestBody || "{}");
    } catch (e) {
      console.error("[解析Update失败]", e.message);
      return new Response("OK");
    }

    // 处理刷新验证链接回调
    if (update.callback_query) {
      const query = update.callback_query;
      if (query.data?.startsWith("refresh_verify:")) {
        const userId = query.from.id;
        const oldVerifyId = query.data.split(":")[1];
        
        // 清理旧验证
        await env.TOPIC_MAP.delete(`verify:${oldVerifyId}`);
        // 发送新验证链接
        await sendVerifyMessage(userId, env);
        // 回复回调
        await tgApiCall(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: "已重新生成验证链接！"
        });
        // 删除旧消息
        await tgApiCall(env, "deleteMessage", {
          chat_id: userId,
          message_id: query.message.message_id
        }).catch(e => console.error("[删除旧验证消息失败]", e.message));
        
        return new Response("OK");
      }
    }

    // 精准识别编辑消息状态
    const isEdit = !!update.edited_message;
    const msg = update.message || update.edited_message;
    if (!msg || msg.service) return new Response("OK");

    // 处理超级群组消息（管理员回复/指令）
    if (msg.chat?.type === "supergroup" && msg.message_thread_id) {
      await handleAdminMessage(msg, env, isEdit, ctx);
      return new Response("OK");
    }

    // 仅处理私聊消息
    if (msg.chat?.type !== "private") return new Response("OK");

    // 基础信息
    const userId = msg.chat.id;
    const userName = msg.from?.first_name || msg.from?.username || "未知用户";
    const userUsername = msg.from?.username ? `@${msg.from.username}` : "无";

    // 检查黑名单/关闭状态
    const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
    const isClosed = await env.TOPIC_MAP.get(`user_closed:${userId}`);
    
    if (isBanned) return new Response("OK");
    if (isClosed) {
      await tgApiCall(env, "sendMessage", {
        chat_id: userId,
        text: "🚫 您的对话已被管理员关闭",
        parse_mode: "Markdown"
      });
      return new Response("OK");
    }

    // 处理 /start 命令
    if ((msg.text || "").trim() === "/start") {
      await handleStartCommand(userId, env);
      // 发送完欢迎信息后，检查验证状态，若未验证则发送验证链接
      const isVerified = await env.TOPIC_MAP.get(`verified:${userId}`) === "1";
      if (!isVerified) {
        const verifyKeys = await env.TOPIC_MAP.list({ prefix: `verify:`, limit: 100 });
        let hasActiveVerify = false;
        
        for (const key of verifyKeys.keys) {
          const verifyData = await env.TOPIC_MAP.get(key.name, { type: "json" }).catch(() => null);
          if (verifyData?.uid === userId.toString()) {
            hasActiveVerify = true;
            break;
          }
        }

        if (!hasActiveVerify) {
          await sendVerifyMessage(userId, env, msg.message_id);
        }
      }
      return new Response("OK");
    }

    // 检查验证状态
    const isVerified = await env.TOPIC_MAP.get(`verified:${userId}`) === "1";
    
    if (isVerified) {
      // 已验证：转发用户消息到群组并处理表情
      await forwardUserMessageToGroup(msg, env, userName, userUsername, isEdit, ctx);
      return new Response("OK");
    }

    // 未验证：发送验证链接（仅当无活跃验证时）
    const verifyKeys = await env.TOPIC_MAP.list({ prefix: `verify:`, limit: 100 });
    let hasActiveVerify = false;
    
    for (const key of verifyKeys.keys) {
      const verifyData = await env.TOPIC_MAP.get(key.name, { type: "json" }).catch(() => null);
      if (verifyData?.uid === userId.toString()) {
        hasActiveVerify = true;
        break;
      }
    }

    if (!hasActiveVerify) {
      await sendVerifyMessage(userId, env, msg.message_id);
    }

    return new Response("OK");

  } catch (error) {
    console.error("[Webhook处理错误]", error.stack || error.message);
    return new Response("OK");
  }
}

// ---------------- 处理 /start 命令 ----------------
async function handleStartCommand(userId, env) {
  const startMessage = `欢迎使用双向私信机器人！

📝 功能说明：
• 发送的消息会自动转发到管理员群组
• 编辑文本消息时会显示🦄表情，1秒后恢复为🕊
• 🕊表情表示消息已成功转发

⚠️ 注意：
• 仅文本消息支持编辑
• 需完成安全验证后才能发送消息`;

  // 发送欢迎信息
  const sendResult = await tgApiCall(env, "sendMessage", {
    chat_id: userId,
    text: startMessage,
    parse_mode: "Markdown"
  });

  // 给欢迎消息添加🕊表情点赞
  if (sendResult.ok) {
    await setUnifiedReaction(
      env,
      userId,
      sendResult.result.message_id,
      null,
      false
    );
  }
}

// ---------------- 处理管理员消息（回复/指令） ----------------
async function handleAdminMessage(msg, env, isEdit = false, ctx) {
  const threadId = msg.message_thread_id;
  const userId = await getUserIdByTopicId(threadId, env);
  const text = (msg.text || "").trim();

  // 指令处理
  if (text.startsWith("/")) {
    await handleAdminCommand(text, userId, threadId, env);
    return;
  }

  // 无绑定用户
  if (!userId) {
    await tgApiCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: "❌ 该话题未绑定用户",
      parse_mode: "Markdown"
    });
    return;
  }

  // 转发管理员回复给用户，并处理表情
  if (msg.media_group_id) {
    await handleAdminMediaReply(msg, userId, env, threadId, isEdit, ctx);
  } else {
    const copyResult = await tgApiCall(env, "copyMessage", {
      chat_id: userId,
      from_chat_id: env.SUPERGROUP_ID,
      message_id: msg.message_id
    });

    if (copyResult.ok) {
      // 1. 给管理员消息添加表情
      await setUnifiedReaction(
        env, 
        env.SUPERGROUP_ID, 
        msg.message_id, 
        threadId, 
        isEdit,
        ctx
      );
      
      // 2. 给用户收到的消息添加表情
      await setUnifiedReaction(
        env,
        userId,
        copyResult.result.message_id,
        null,
        isEdit,
        ctx
      );
    } else {
      console.error(`[转发管理员回复失败] 用户ID:${userId} 错误:${copyResult.description}`);
    }
  }
}

// ---------------- 处理管理员指令 ----------------
async function handleAdminCommand(text, userId, threadId, env) {
  // 无绑定用户时的指令处理
  if (!userId && !["/userinfo"].includes(text)) {
    await tgApiCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: "❌ 该话题未绑定用户",
      parse_mode: "Markdown"
    });
    return;
  }

  switch (text) {
    case "/userinfo":
      // 查看用户信息
      const userInfo = await tgApiCall(env, "getChat", { chat_id: userId });
      const infoText = userInfo.ok 
        ? `📋 用户信息\n├─ ID：${userId}\n├─ 昵称：${userInfo.result.first_name || "无"}\n├─ 用户名：${userInfo.result.username ? `@${userInfo.result.username}` : "无"}\n└─ 验证状态：${await env.TOPIC_MAP.get(`verified:${userId}`) === "1" ? "✅ 已验证" : "❌ 未验证"}`
        : `📋 用户ID：${userId}\n❌ 获取详细信息失败`;
      
      await tgApiCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: infoText,
        parse_mode: "Markdown"
      });
      break;

    case "/reset_verify":
      // 重置验证状态
      await env.TOPIC_MAP.delete(`verified:${userId}`);
      // 清理验证链接
      const verifyKeys = await env.TOPIC_MAP.list({ prefix: `verify:`, limit: 100 });
      for (const key of verifyKeys.keys) {
        const verifyData = await env.TOPIC_MAP.get(key.name, { type: "json" }).catch(() => null);
        if (verifyData?.uid === userId.toString()) await env.TOPIC_MAP.delete(key.name);
      }
      // 通知管理员
      await tgApiCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `✅ 用户 ${userId} 的验证状态已重置`,
        parse_mode: "Markdown"
      });
      break;

    case "/close":
      // 关闭对话
      await env.TOPIC_MAP.put(`user_closed:${userId}`, "1");
      await tgApiCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `✅ 用户 ${userId} 的对话已关闭`,
        parse_mode: "Markdown"
      });
      break;

    case "/open":
      // 打开对话
      await env.TOPIC_MAP.delete(`user_closed:${userId}`);
      await tgApiCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `✅ 用户 ${userId} 的对话已开启`,
        parse_mode: "Markdown"
      });
      break;

    case "/ban":
      // 封禁用户
      await env.TOPIC_MAP.put(`banned:${userId}`, "1");
      await tgApiCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `✅ 用户 ${userId} 已被封禁`,
        parse_mode: "Markdown"
      });
      break;

    case "/unban":
      // 解封用户
      await env.TOPIC_MAP.delete(`banned:${userId}`);
      await tgApiCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `✅ 用户 ${userId} 已被解封`,
        parse_mode: "Markdown"
      });
      break;

    default:
      // 处理验证有效期设置
      if (text.startsWith("/verify_ttl")) {
        const parts = text.split(" ");
        if (parts.length < 2) {
          await tgApiCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: "❌ 格式：/verify_ttl 7d/30d/1y/永久",
            parse_mode: "Markdown"
          });
          return;
        }

        const ttlMap = { "7d": 604800, "30d": 2592000, "1y": 31536000, "永久": 0 };
        const ttl = ttlMap[parts[1].toLowerCase()];
        
        if (ttl === undefined) {
          await tgApiCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: "❌ 支持的有效期：7d/30d/1y/永久",
            parse_mode: "Markdown"
          });
          return;
        }

        if (ttl > 0) {
          await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: ttl });
        } else {
          await env.TOPIC_MAP.put(`verified:${userId}`, "1");
        }

        await tgApiCall(env, "sendMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: threadId,
          text: `✅ 用户 ${userId} 的验证有效期已设置为：${parts[1]}`,
          parse_mode: "Markdown"
        });
      }
      break;
  }
}

// ---------------- 转发用户消息到群组（核心：话题重建+表情处理） ----------------
async function forwardUserMessageToGroup(msg, env, userName, userUsername, isEdit = false, ctx) {
  try {
    // 编辑消息仅支持文本类型
    if (isEdit && !msg.text) {
      console.warn("[编辑消息限制] 仅支持文本消息，忽略媒体消息编辑");
      return;
    }

    const userId = msg.from.id;
    // 获取/重建用户话题ID（核心修复：话题删除后自动重建）
    const topicId = await getOrRecreateTopicId(userId, env, userName, userUsername);
    
    if (!topicId) {
      await tgApiCall(env, "sendMessage", {
        chat_id: userId,
        text: "⚠️ 话题创建失败，请稍后重试",
        parse_mode: "Markdown"
      });
      return;
    }

    if (msg.media_group_id && !isEdit) {
      // 处理媒体组消息（非编辑）
      await handleUserMediaGroup(msg, env, topicId, isEdit, ctx);
    } else {
      let forwardResult, targetMsgId = null;
      
      // 编辑消息强制使用copyMessage（forward不支持编辑后的消息）
      if (isEdit) {
        forwardResult = await tgApiCall(env, "copyMessage", {
          chat_id: env.SUPERGROUP_ID,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
          message_thread_id: topicId,
          text: msg.text // 强制传递最新编辑的文本
        });
      } else {
        // 普通消息优先forward
        forwardResult = await tgApiCall(env, "forwardMessage", {
          chat_id: env.SUPERGROUP_ID,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
          message_thread_id: topicId
        });

        // forward失败则降级为copy
        if (!forwardResult.ok) {
          forwardResult = await tgApiCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id,
            message_thread_id: topicId
          });
        }
      }

      if (forwardResult.ok) {
        targetMsgId = forwardResult.result.message_id;
      }

      if (targetMsgId) {
        // 1. 给群组中的消息添加表情
        await setUnifiedReaction(
          env,
          env.SUPERGROUP_ID,
          targetMsgId,
          topicId,
          isEdit,
          ctx
        );
        
        // 2. 给用户的原始消息添加表情
        await setUnifiedReaction(
          env,
          msg.chat.id,
          msg.message_id,
          null,
          isEdit,
          ctx
        );
      } else {
        console.error(`[转发失败] 用户ID:${userId} 消息ID:${msg.message_id} 错误:${forwardResult?.description}`);
      }
    }
  } catch (error) {
    console.error("[转发用户消息失败]", error.message);
    await tgApiCall(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: "🚫 消息发送失败，请稍后重试",
      parse_mode: "Markdown"
    }).catch(() => {});
  }
}

// ---------------- 核心：统一表情设置（修复编辑消息🦄→🕊切换） ----------------
async function setUnifiedReaction(env, chatId, messageId, threadId = null, isEdit = false, ctx, maxRetries = 3) {
  // 封装表情设置函数，增加重试机制
  const setReaction = async (emoji) => {
    const params = {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji: emoji }],
      is_big: false // 避免大表情影响体验
    };
    
    if (threadId !== null) {
      params.message_thread_id = threadId;
    }

    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await tgApiCall(env, "setMessageReaction", params);
        if (result.ok) {
          return true;
        }
        // 400错误（话题不存在）直接终止重试
        if (result.error_code === 400 && result.description.includes("message_thread_id")) {
          console.error(`[表情设置失败] 话题不存在 chatId:${chatId} threadId:${threadId}`);
          return false;
        }
        // 其他错误重试
        await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
      } catch (error) {
        if (i === maxRetries - 1) {
          console.error(`[设置表情失败] 表情:${emoji} 重试${maxRetries}次失败:`, error.message);
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
      }
    }
    return false;
  };

  try {
    // 第一步：清空原有表情（避免叠加）
    await setReaction("");
    
    // 第二步：设置初始表情
    const initialEmoji = isEdit ? "🦄" : "🕊";
    const setInitial = await setReaction(initialEmoji);
    
    // 第三步：编辑消息1秒后切换为🕊
    if (isEdit && setInitial) {
      // 使用ctx.waitUntil确保Worker不提前终止
      ctx.waitUntil(new Promise(resolve => {
        setTimeout(async () => {
          await setReaction("🕊");
          resolve();
        }, 1000); // 严格1秒延迟
      }));
    }
  } catch (error) {
    console.error("[统一点赞失败]", error.message);
  }
}

// ---------------- 处理管理员媒体组回复 ----------------
async function handleAdminMediaReply(msg, userId, env, threadId, isEdit = false, ctx) {
  const groupId = msg.media_group_id;
  const cacheKey = `admin_media:${groupId}`;
  
  let mediaGroup = await env.TOPIC_MAP.get(cacheKey, { type: "json" }).catch(() => null) || { items: [] };

  // 提取媒体信息
  let mediaItem = null;
  if (msg.photo) mediaItem = { type: "photo", media: msg.photo.pop().file_id, caption: msg.caption };
  if (msg.video) mediaItem = { type: "video", media: msg.video.file_id, caption: msg.caption };
  if (msg.document) mediaItem = { type: "document", media: msg.document.file_id, caption: msg.caption };

  if (mediaItem) {
    mediaGroup.items.push(mediaItem);
    await env.TOPIC_MAP.put(cacheKey, JSON.stringify(mediaGroup), { expirationTtl: 60 });

    // 延迟发送（等待所有媒体分片）
    setTimeout(async () => {
      const latestMedia = await env.TOPIC_MAP.get(cacheKey, { type: "json" }).catch(() => null);
      if (latestMedia?.items.length) {
        const sendResult = await tgApiCall(env, "sendMediaGroup", {
          chat_id: userId,
          media: latestMedia.items.map(item => ({
            type: item.type,
            media: item.media,
            caption: item.caption || ""
          }))
        });

        if (sendResult.ok) {
          // 1. 给管理员的媒体消息添加表情
          await setUnifiedReaction(env, env.SUPERGROUP_ID, msg.message_id, threadId, isEdit, ctx);
          
          // 2. 给用户收到的每条媒体消息添加表情
          for (const msgItem of sendResult.result) {
            await setUnifiedReaction(env, userId, msgItem.message_id, null, isEdit, ctx);
          }
        }

        // 清理缓存
        await env.TOPIC_MAP.delete(cacheKey);
      }
    }, 2000);
  }
}

// ---------------- 处理用户媒体组消息 ----------------
async function handleUserMediaGroup(msg, env, topicId, isEdit = false, ctx) {
  // 编辑消息不支持媒体组
  if (isEdit) return;

  const groupId = msg.media_group_id;
  const cacheKey = `user_media:${groupId}`;
  
  let mediaGroup = await env.TOPIC_MAP.get(cacheKey, { type: "json" }).catch(() => null) || { items: [] };

  // 提取媒体信息
  let mediaItem = null;
  if (msg.photo) mediaItem = { type: "photo", media: msg.photo.pop().file_id, caption: msg.caption };
  if (msg.video) mediaItem = { type: "video", media: msg.video.file_id, caption: msg.caption };
  if (msg.document) mediaItem = { type: "document", media: msg.document.file_id, caption: msg.caption };

  if (mediaItem) {
    mediaGroup.items.push(mediaItem);
    await env.TOPIC_MAP.put(cacheKey, JSON.stringify(mediaGroup), { expirationTtl: 60 });

    // 延迟发送（等待所有媒体分片）
    setTimeout(async () => {
      const latestMedia = await env.TOPIC_MAP.get(cacheKey, { type: "json" }).catch(() => null);
      if (latestMedia?.items.length) {
        const sendResult = await tgApiCall(env, "sendMediaGroup", {
          chat_id: env.SUPERGROUP_ID,
          media: latestMedia.items.map(item => ({
            type: item.type,
            media: item.media,
            caption: item.caption || ""
          })),
          message_thread_id: topicId
        });

        if (sendResult.ok) {
          // 1. 给用户原始消息添加表情
          await setUnifiedReaction(env, msg.chat.id, msg.message_id, null, isEdit, ctx);
          
          // 2. 给群组中的每条媒体消息添加表情
          for (const msgItem of sendResult.result) {
            await setUnifiedReaction(env, env.SUPERGROUP_ID, msgItem.message_id, topicId, isEdit, ctx);
          }
        }

        // 清理缓存
        await env.TOPIC_MAP.delete(cacheKey);
      }
    }, 2000);
  }
}

// ---------------- 获取/重建用户话题（核心修复：删除后自动重建） ----------------
async function getOrRecreateTopicId(userId, env, userName, userUsername) {
  const topicKey = `user_topic:${userId}`;
  let topicId = await env.TOPIC_MAP.get(topicKey).catch(() => null);

  // 1. 有缓存的话题ID，先验证是否存在
  if (topicId) {
    topicId = Number(topicId);
    // 验证话题是否存在（改用更可靠的getChatForumTopic接口）
    const checkResult = await tgApiCall(env, "getChatForumTopic", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: topicId
    }).catch(() => ({ ok: false }));
    
    // 话题存在，直接返回
    if (checkResult.ok) {
      return topicId;
    }
    
    // 话题不存在，清理旧缓存（含反向映射）
    console.warn(`[话题不存在] 用户ID:${userId} 旧话题ID:${topicId}，开始重建`);
    await env.TOPIC_MAP.delete(topicKey);
    await env.TOPIC_MAP.delete(`topic_user:${topicId}`); // 清理旧反向映射
  }

  // 2. 创建新话题
  userName = userName || (await getUserName(userId, env));
  const topicName = userUsername ? `${userUsername}(${userId})` : `${userName}(${userId})`;
  
  const createResult = await tgApiCall(env, "createForumTopic", {
    chat_id: env.SUPERGROUP_ID,
    name: topicName,
    icon_color: 0x6FB9F0 // 蓝色主题色
  });

  if (createResult.ok) {
    const newTopicId = createResult.result.message_thread_id;
    await env.TOPIC_MAP.put(topicKey, newTopicId.toString());
    // 新增：建立话题ID→用户ID的反向映射（关键修复）
    await env.TOPIC_MAP.put(`topic_user:${newTopicId}`, userId.toString());

    // 首次创建话题，发送用户信息
    await tgApiCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: newTopicId,
      text: `📋 新用户会话\n├─ 昵称：${userName}\n├─ 用户名：${userUsername || "无"}\n└─ 用户ID：${userId}`,
      parse_mode: "Markdown"
    });

    return newTopicId;
  }

  console.error(`[创建话题失败] 用户ID:${userId} 错误:${createResult.description}`);
  return 0;
}

// ---------------- 辅助函数 ----------------
async function sendVerifyMessage(userId, env, msgId = null) {
  // 清理旧验证链接
  const verifyKeys = await env.TOPIC_MAP.list({ prefix: `verify:`, limit: 100 });
  for (const key of verifyKeys.keys) {
    const verifyData = await env.TOPIC_MAP.get(key.name, { type: "json" }).catch(() => null);
    if (verifyData?.uid === userId.toString()) await env.TOPIC_MAP.delete(key.name);
  }

  // 生成新验证链接
  const verifyId = Math.random().toString(36).slice(2, 15);
  await env.TOPIC_MAP.put(
    `verify:${verifyId}`,
    JSON.stringify({ uid: userId.toString(), msgId }),
    { expirationTtl: 300 } // 5分钟过期
  );

  const verifyUrl = `https://${env.WORKER_DOMAIN}/turnstile-verify?vid=${verifyId}&uid=${userId}`;
  
  // 发送验证消息
  await tgApiCall(env, "sendMessage", {
    chat_id: userId,
    text: `🛡️ 安全验证\n\n请完成人机验证后才能发送消息：`,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_to_message_id: msgId,
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ 点击完成验证", url: verifyUrl }],
        [{ text: "🔄 重新获取链接", callback_data: `refresh_verify:${verifyId}` }]
      ]
    }
  });
}

// ---------------- 修复：通过话题ID获取用户ID（优先反向映射） ----------------
async function getUserIdByTopicId(threadId, env) {
  // 优先读取反向映射（性能+准确性提升）
  const directUserId = await env.TOPIC_MAP.get(`topic_user:${threadId}`).catch(() => null);
  if (directUserId) return Number(directUserId);
  
  // 兼容旧数据：遍历查找
  const list = await env.TOPIC_MAP.list({ prefix: "user_topic:" });
  for (const key of list.keys) {
    const storedTopicId = await env.TOPIC_MAP.get(key.name).catch(() => null);
    if (storedTopicId?.toString() === threadId.toString()) {
      const userId = Number(key.name.replace("user_topic:", ""));
      // 同步建立反向映射（修复旧数据）
      await env.TOPIC_MAP.put(`topic_user:${threadId}`, userId.toString());
      return userId;
    }
  }
  return null;
}

async function getUserName(userId, env) {
  const res = await tgApiCall(env, "getChat", { chat_id: userId });
  return res.ok ? (res.result.first_name || res.result.username || "未知用户") : "未知用户";
}

async function handleTurnstileVerify(request, env) {
  const url = new URL(request.url);
  const verifyId = url.searchParams.get("vid");
  const userId = url.searchParams.get("uid");

  if (!verifyId || !userId || isNaN(Number(userId))) {
    return new Response(generateExpiredPage("无效的验证链接", "链接参数错误或已失效"), {
      status: 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }

  // GET：返回验证页面
  if (request.method === "GET") {
    const verifyState = await env.TOPIC_MAP.get(`verify:${verifyId}`);
    if (!verifyState) {
      return new Response(generateExpiredPage("验证链接已过期", "请重新发送消息获取新的验证链接"), {
        status: 400,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache"
        }
      });
    }

    const html = generateVerifyPage(env.TURNSTILE_SITE_KEY, verifyId, userId);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }

  // POST：处理验证提交
  if (request.method === "POST") {
    try {
      const { token } = await request.json();
      
      // 验证Turnstile
      const turnstileRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: request.headers.get("CF-Connecting-IP")
        })
      });

      const turnstileData = await turnstileRes.json();
      if (!turnstileData.success) {
        return new Response(JSON.stringify({
          success: false,
          error: turnstileData["error-codes"]?.join(", ") || "验证失败，请重试"
        }), { headers: { "Content-Type": "application/json" } });
      }

      // 验证成功，标记用户为已验证
      await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: 604800 }); // 7天有效期
      
      // 清理验证链接
      const verifyKeys = await env.TOPIC_MAP.list({ prefix: `verify:`, limit: 100 });
      for (const key of verifyKeys.keys) {
        const verifyData = await env.TOPIC_MAP.get(key.name, { type: "json" }).catch(() => null);
        if (verifyData?.uid === userId.toString()) await env.TOPIC_MAP.delete(key.name);
      }

      // 转发验证前的待发送消息
      const verifyState = await env.TOPIC_MAP.get(`verify:${verifyId}`, { type: "json" }).catch(() => null);
      if (verifyState?.msgId) {
        const msgRes = await tgApiCall(env, "getMessage", {
          chat_id: userId,
          message_id: verifyState.msgId
        });
        
        if (msgRes.ok) {
          const userName = msgRes.result.from.first_name || msgRes.result.from.username || "未知用户";
          const userUsername = msgRes.result.from.username ? `@${msgRes.result.from.username}` : "无";
          await forwardUserMessageToGroup(msgRes.result, env, userName, userUsername);
        }
      }

      // 通知用户验证成功
      await tgApiCall(env, "sendMessage", {
        chat_id: userId,
        text: "✅ 验证成功！您现在可以正常发送消息了",
        parse_mode: "Markdown",
        disable_notification: false
      });

      return new Response(JSON.stringify({
        success: true,
        message: "验证成功，即将返回Telegram"
      }), { headers: { "Content-Type": "application/json" } });

    } catch (error) {
      console.error("[验证处理失败]", error.message);
      return new Response(JSON.stringify({
        success: false,
        error: "服务器内部错误，请重试"
      }), { headers: { "Content-Type": "application/json" } });
    }
  }

  return new Response("不支持的请求方法", { status: 405 });
}

// ---------------- 生成过期/无效链接页面 ----------------
function generateExpiredPage(title, description) {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    }
    .icon { font-size: 64px; margin-bottom: 20px; }
    .title { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #333; }
    .desc { color: #666; line-height: 1.6; margin-bottom: 30px; }
    .btn {
      display: inline-block;
      padding: 12px 30px;
      background: #0088cc;
      color: white;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
      transition: background 0.2s;
    }
    .btn:hover { background: #006699; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; }
      .card { background: #2d2d2d; }
      .title { color: #fff; }
      .desc { color: #ccc; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h1 class="title">${title}</h1>
    <p class="desc">${description}</p>
    <a href="javascript:window.close()" class="btn">关闭窗口</a>
  </div>
</body>
</html>
  `;
}

// ---------------- 生成验证页面 ----------------
function generateVerifyPage(siteKey, verifyId, userId) {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>安全验证</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 450px;
      width: 100%;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    }
    .header { text-align: center; margin-bottom: 30px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    .title { font-size: 22px; font-weight: 600; color: #333; }
    .subtitle { color: #666; margin-top: 8px; }
    .turnstile-container { margin: 20px 0; min-height: 70px; }
    #verify-btn {
      width: 100%;
      padding: 14px;
      background: #0088cc;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
      margin-top: 10px;
    }
    #verify-btn:disabled {
      background: #999;
      cursor: not-allowed;
    }
    #verify-btn:hover:not(:disabled) {
      background: #006699;
    }
    .message {
      padding: 12px;
      border-radius: 8px;
      margin-top: 20px;
      display: none;
    }
    .success { background: #e8f5e9; color: #2e7d32; }
    .error { background: #ffebee; color: #c62828; }
    .loading {
      display: none;
      text-align: center;
      margin: 20px 0;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid #eee;
      border-top: 3px solid #0088cc;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; }
      .card { background: #2d2d2d; }
      .title { color: #fff; }
      .subtitle, .desc { color: #ccc; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon">🛡️</div>
      <h1 class="title">安全验证</h1>
      <p class="subtitle">完成验证后即可发送消息</p>
    </div>
    
    <div id="turnstile-widget" class="turnstile-container"></div>
    
    <div class="loading" id="loading">
      <div class="spinner"></div>
    </div>
    
    <div id="success-msg" class="message success"></div>
    <div id="error-msg" class="message error"></div>
    
    <button id="verify-btn" disabled>完成验证</button>
  </div>

  <script>
    let token = "";
    let widgetId = null;
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    // 初始化Turnstile
    window.onload = () => {
      initTurnstile();
      document.getElementById('verify-btn').addEventListener('click', submitVerify);
    };

    function initTurnstile() {
      if (window.turnstile) {
        if (widgetId) window.turnstile.remove(widgetId);
        widgetId = window.turnstile.render('#turnstile-widget', {
          sitekey: "${siteKey}",
          theme: isDark ? 'dark' : 'light',
          callback: (t) => {
            token = t;
            document.getElementById('verify-btn').disabled = false;
            document.getElementById('error-msg').style.display = 'none';
          },
          'error-callback': (err) => {
            showMessage('error', '验证加载失败，请刷新页面重试');
          }
        });
      }
    }

    // 监听主题切换
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      initTurnstile();
    });

    // 提交验证
    async function submitVerify() {
      if (!token) return;
      
      const btn = document.getElementById('verify-btn');
      const loading = document.getElementById('loading');
      const successMsg = document.getElementById('success-msg');
      const errorMsg = document.getElementById('error-msg');
      
      // 重置状态
      successMsg.style.display = 'none';
      errorMsg.style.display = 'none';
      btn.disabled = true;
      loading.style.display = 'block';
      btn.textContent = '验证中...';
      
      try {
        const res = await fetch(window.location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        
        const data = await res.json();
        
        loading.style.display = 'none';
        if (data.success) {
          successMsg.textContent = '✅ 验证成功！即将返回Telegram';
          successMsg.style.display = 'block';
          btn.style.display = 'none';
          
          // 延迟关闭，确保消息发送成功
          setTimeout(() => {
            if (window.TelegramWebviewProxy) {
              window.TelegramWebviewProxy.close();
            } else {
              window.close();
            }
          }, 1500);
        } else {
          showMessage('error', '❌ ' + (data.error || '验证失败，请重试'));
          btn.disabled = false;
          btn.textContent = '重新验证';
          initTurnstile();
          token = '';
        }
      } catch (err) {
        loading.style.display = 'none';
        showMessage('error', '❌ 网络错误：' + err.message);
        btn.disabled = false;
        btn.textContent = '重新验证';
        initTurnstile();
        token = '';
      }
    }

    function showMessage(type, text) {
      const successEl = document.getElementById('success-msg');
      const errorEl = document.getElementById('error-msg');
      
      if (type === 'success') {
        successEl.textContent = text;
        successEl.style.display = 'block';
        errorEl.style.display = 'none';
      } else {
        errorEl.textContent = text;
        errorEl.style.display = 'block';
        successEl.style.display = 'none';
      }
    }

    // 回车提交
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !document.getElementById('verify-btn').disabled) {
        submitVerify();
      }
    });
  </script>
</body>
</html>
  `;
}

// ---------------- Telegram API调用函数 ----------------
async function tgApiCall(env, method, body) {
  try {
    const controller = new AbortController();
    // 10秒超时
    setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const result = await res.json();
    if (!result.ok) {
      console.error(`[TG API错误] ${method} - 错误码:${result.error_code} 描述:${result.description}`);
    }
    return result;
  } catch (error) {
    console.error(`[TG API调用失败] ${method}:`, error.message);
    return { ok: false, description: error.message, error_code: 500 };
  }
}
