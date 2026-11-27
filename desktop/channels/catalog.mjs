export const platforms = [
  { id: 'wechat', name: 'WeChat', qr: true, fields: [],
    description: ['扫码登录微信机器人', 'Connect a WeChat bot using a QR code'] },
  { id: 'wecom', guide: 'https://work.weixin.qq.com/wework_admin/frame#manageTools', name: 'WeCom', fields: ['id', 'secret'],
    description: ['连接企业微信智能机器人', 'Connect a WeCom intelligent bot'] },
  { id: 'qq', guide: 'https://q.qq.com/', name: 'QQ', fields: ['id', 'secret'],
    description: ['通过官方 QQ 机器人 API 连接 QQ', 'Connect through the official QQ Bot API'] },
  { id: 'feishu', guide: 'https://open.feishu.cn/app', name: 'Feishu / Lark', fields: ['id', 'secret', 'region'],
    description: ['连接飞书机器人用于团队协作', 'Connect a Feishu or Lark team bot'] },
  { id: 'dingtalk', guide: 'https://open-dev.dingtalk.com/fe/app', name: 'DingTalk', fields: ['id', 'secret'],
    description: ['连接钉钉机器人用于团队协作', 'Connect a DingTalk team bot'] },
  { id: 'telegram', guide: 'https://t.me/BotFather', name: 'Telegram', fields: ['token'],
    description: ['通过 Bot API 连接 Telegram 机器人', 'Connect a Telegram bot through the Bot API'] },
  { id: 'discord', guide: 'https://discord.com/developers/applications', name: 'Discord', fields: ['token'],
    description: ['连接 Discord Bot，用于私信和服务器频道', 'Connect a bot for DMs and server channels'] },
  { id: 'whatsapp', name: 'WhatsApp', qr: true, fields: [],
    description: ['通过 Baileys 连接 WhatsApp（扫码登录）', 'Scan a QR code to link a WhatsApp device'] },
]
export function platformById(id) {
  const platform = platforms.find(item => item.id === id)
  if (!platform) throw new Error('请选择支持的频道。')
  return platform
}
