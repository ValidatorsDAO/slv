export const messages: Record<string, string> = {
  'SLV AI Onboarding': 'SLV AI 初始化',
  'Select your language': '请选择语言',
  'Language saved. Please run `slv onboard` again to continue.':
    '语言已保存。请再次运行 `slv onboard` 以继续。',

  'Security warning — please read.': '安全警告 — 请阅读。',
  'SLV AI Console can execute commands on your system.':
    'SLV AI Console 可以在您的系统上执行命令。',
  'A bad prompt can trick it into doing unsafe things.':
    '恶意提示可能会诱使其执行不安全的操作。',
  'Recommended:': '建议:',
  "- Don't paste untrusted prompts.": '- 请勿粘贴不受信任的提示。',
  '- `slv bot init` ships a Solana transaction sample designed to be improved with your AI before real use. When using real SOL, assets may decrease — use at your own risk.':
    '- `slv bot init` 提供的是 Solana 交易示例模板，设计为先用您的 AI 改进后再实际使用。使用真实 SOL 时，资产可能减少，请自行承担风险。',
  '- Keep secrets out of the conversation.': '- 不要在对话中包含敏感信息。',
  'I understand this is powerful and inherently risky. Continue?':
    '我了解其功能强大并存在风险。继续吗？',
  'Yes': '是',
  'No': '否',
  'Setup cancelled.': '已取消设置。',

  'SLV API Key': 'SLV API 密钥',
  'Get your free API key: https://discord.gg/S2gEbJTGJA':
    '获取免费 API 密钥: https://discord.gg/S2gEbJTGJA',
  '🔑 SLV API Key (or press Enter to skip)': '🔑 SLV API 密钥（按 Enter 跳过）',
  'SLV API Key saved.': 'SLV API 密钥已保存。',
  'Skipped. You can run `slv login` later.':
    '已跳过。您可以稍后运行 `slv login`。',
  'Using SLV AI (powered by your SLV API Key).':
    '使用 SLV AI（由您的 SLV API 密钥驱动）。',

  'Agent Setup': '代理设置',
  'Your name': '您的姓名',
  'Name is required': '姓名为必填项',
  'What should the AI call you?': 'AI 应如何称呼您？',
  'Name your main AI agent': '为您的主 AI 代理命名',
  'What will you be doing? (↑↓ move, Space toggle, Enter confirm)':
    '您将用于什么？（↑↓ 移动，空格切换，Enter 确认）',
  'Deployment mode': '部署模式',
  'Local — deploy to this machine': '本地 — 部署到本机',
  'Remote — deploy to remote servers via SSH':
    '远程 — 通过 SSH 部署到远程服务器',

  'GitHub Setup (optional)': 'GitHub 设置（可选）',
  'GitHub CLI already authenticated.': 'GitHub CLI 已认证。',
  'GitHub CLI (gh) not found. Install it from https://cli.github.com/':
    '未找到 GitHub CLI (gh)。请从 https://cli.github.com/ 安装。',
  'Skipped. You can set up GitHub later.': '已跳过。您可以稍后设置 GitHub。',
  'Set up GitHub authentication? (enables repo creation, PRs, etc.)':
    '设置 GitHub 认证？（启用仓库创建、PR 等）',
  'Yes — run gh auth login': '是 — 运行 gh auth login',
  'Skip for now': '暂时跳过',
  'Running `gh auth login`...': '正在运行 `gh auth login`...',
  'GitHub authenticated.': 'GitHub 已认证。',
  'GitHub authentication failed. You can retry with `gh auth login`.':
    'GitHub 认证失败。您可以使用 `gh auth login` 重试。',
  'Skipped. You can run `gh auth login` later.':
    '已跳过。您可以稍后运行 `gh auth login`。',

  'Notifications (optional)': '通知（可选）',
  'Discord Webhook URL for notifications (Enter to skip)':
    '用于通知的 Discord Webhook URL（Enter 跳过）',
  'Discord Webhook saved to ~/.slv/api.yml':
    'Discord Webhook 已保存到 ~/.slv/api.yml',
  'Skipped.': '已跳过。',

  'Agent files saved to ~/.slv/agent/':
    '代理文件已保存到 ~/.slv/agent/',
  'AI configuration saved to ~/.slv/api.yml':
    'AI 配置已保存到 ~/.slv/api.yml',
  'Agent:': '代理:',
  'Run `slv c` to start the AI console.':
    '运行 `slv c` 启动 AI 控制台。',

  'slv bot init — trade-app is an example only':
    'slv bot init — trade-app 仅为示例',
  'The trade-app template is only an example of Solana on-chain transaction detection and submission. When the app starts, a wallet.json is created; trading begins once you deposit SOL into it, and your assets may decrease. Use this sample as a base for your own AI-assisted improvements — it can greatly reduce the effort of building Solana apps, but it is powerful and may cause financial loss in some cases.':
    'trade-app 模板只是 Solana 链上交易检测与提交的示例。应用启动时会创建 wallet.json；一旦您向其中存入 SOL，交易便会开始，您的资产可能会减少。请将此示例作为基础，结合您手头的 AI 进行改进 — 这将大幅减少构建 Solana 应用的工作量。但是，它非常强大，在某些情况下可能导致资金损失，请务必理解这一点。',
  'I understand the above and will use it at my own risk.':
    '我已理解上述内容，并自行承担风险使用。',
  'bot init cancelled. You can run `slv bot init` again when ready.':
    '已取消 bot init。准备好后可再次运行 `slv bot init`。',

  'SLV AI Console': 'SLV AI 控制台',
  'Provider:': '提供商:',
  'Model:': '模型:',
  'Type /exit to quit, /clear to reset. Press Enter to send.':
    '输入 /exit 退出，/clear 重置。按 Enter 发送。',
  'Hey there! 👋': '你好！👋',
  'Hey {name}! 👋': '你好，{name}！👋',
  "I'm {agent}, your SLV commander.": '我是 {agent}，您的 SLV 指挥官。',
  "I'm your SLV assistant.": '我是您的 SLV 助手。',
  "Here's my crew:": '这是我的团队:',
  'What would you like to work on today?': '今天想做什么？',
  'Solana Validator deployments & management':
    'Solana 验证者部署与管理',
  'RPC nodes (Index RPC, gRPC Geyser, combos)':
    'RPC 节点 (Index RPC、gRPC Geyser、组合)',
  'Trading bots & Solana apps': '交易机器人与 Solana 应用',
  'Find optimized Solana server resources':
    '寻找最优 Solana 服务器资源',
  'Benchmarks & connectivity testing': '基准测试与连通性测试',
  'Goodbye!': '再见！',

  "Focused on Solana App Development. Say 'new trade bot' when you're ready.":
    '专注于 Solana 应用开发。准备好后请说 "new trade bot"。',
  'Focused on App Development. You have 1 trade app: {name}.':
    '专注于应用开发。您有 1 个交易应用: {name}。',
  'Focused on App Development. You have {count} trade apps in ~/slv/.':
    '专注于应用开发。~/slv/ 中共有 {count} 个交易应用。',
  'Focused on Solana Validator Operations. Ask me about deploys, health, or upgrades.':
    '专注于 Solana 验证者运维。可询问部署、健康检查或升级。',
  'Focused on RPC / gRPC Node Operations. Ask me about endpoint setup, health, or tuning.':
    '专注于 RPC / gRPC 节点运维。可询问端点配置、健康或调优。',
  'Mixed focus — validator + app / rpc. Use /focus <validator|rpc|app> to narrow.':
    '混合焦点 — validator + app / rpc。使用 `/focus <validator|rpc|app>` 进行细分。',
}
