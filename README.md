# Telegram 双向机器人 (Cloudflare Worker版)
基于Cloudflare Worker实现的Telegram双向机器人，支持自动点赞、人机验证、话题管理等功能，极简原生体验。

## 核心功能
### ✨ 主要特性

1. **双向消息转发**：用户私聊消息 ↔ 超级群组话题，支持文本/图片/视频/文档等媒体类型
2. **智能自动点赞**：统一使用🕊表情点赞，编辑消息时先显示🦄，1秒后自动切换为🕊
3. **安全验证机制**：基于Cloudflare Turnstile的人机验证，隐藏原始链接，简化验证流程
4. **话题管理**：自动为每个用户创建专属话题，名称格式为@用户名(用户ID)，仅首次显示用户信息
5. **管理员功能**：支持用户信息查看、验证重置、对话开关、封禁/解封、验证有效期设置等指令
6. **极简体验**：移除转发按钮，隐藏冗余提示，重置验证不通知用户，保持Telegram原生交互体验
7. **健壮性保障**：完善的错误处理、重试机制、超时控制，支持健康检查接口


### 🛠 管理员指令
| 指令 | 功能 |
|------|------|
| `/userinfo` | 查看当前话题绑定的用户信息 |
| `/reset_verify` | 重置用户验证状态（仅通知管理员） |
| `/close` | 关闭用户对话 |
| `/open` | 打开用户对话 |
| `/ban` | 封禁用户 |
| `/unban` | 解封用户 |
| `/verify_ttl 7d/30d/1y/永久` | 设置用户验证有效期 |

## 部署说明
### 环境变量配置

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `BOT_TOKEN` | Telegram机器人Token（@BotFather获取） | ✅ |
| `SUPERGROUP_ID` | 超级群组ID（需开启论坛功能） | ✅ |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile站点密钥 | ✅ |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile密钥 | ✅ |
| `WORKER_DOMAIN` | Worker自定义域名（用于验证链接） | ✅ |

### 健康检查
访问 `https://<你的WORKER_DOMAIN>/health` 可查看机器人运行状态，返回示例：
```json
{
"status": "ok",
"timestamp": 1735689600000,
"env_check": {
 "bot_token": "配置完成",
 "supergroup_id": "配置完成",
 "turnstile": "配置完成",
 "worker_domain": "配置完成"
    }
}
```
### 部署步骤
## 一键部署
点击下方按钮直接部署到 Cloudflare Workers

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yourusername/tgbot)

## 手动部署
1. 新建Cloudflare Worker，复制完整代码
2. 配置上述环境变量
3. 设置Telegram Webhook：`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER_DOMAIN>`
4. 确保超级群组已开启话题模式，并将机器人设为管理员

### 功能亮点
- **双向消息转发**：用户私聊消息自动转发到超级群组对应话题，管理员回复自动转发给用户
- **媒体支持**：支持图片、视频、文档等媒体组消息转发
- **错误处理**：完善的重试机制和错误日志，确保稳定性
- **主题适配**：验证页面支持明暗主题自动切换
- **体验优化**：验证成功后自动返回Telegram客户端，无需手动操作

## 技术细节
- 基于Cloudflare Worker和KV存储实现
- 使用Telegram Bot API进行消息交互
- Cloudflare Turnstile提供人机验证保护
- 支持消息编辑、媒体组、话题管理等高级功能

## 注意事项
1. 确保机器人拥有超级群组的管理员权限（需允许管理话题、发送消息等）
2. 超级群组必须开启话题模式
3. Turnstile验证链接有效期为5分钟，超时需重新获取
4. 所有API调用设置10秒超时，确保不会阻塞Worker执行

### 感谢开源
- [TG-RUbot](https://github.com/Russellgogogogo/TG-RUbot)
- [telegram_private_chatbot](https://github.com/jikssha/telegram_private_chatbot)
