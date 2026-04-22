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

  '👂 Understanding your request…': '👂 正在理解您的请求…',
  'Understanding your request...': '正在理解您的请求...',
  '🎓 Intent detected: {intent}': '🎓 已识别意图: {intent}',
  '🧰 Enabling tools: {tools}': '🧰 正在启用工具: {tools}',
  '📚 Loading context: {modules}': '📚 正在加载上下文: {modules}',
  '🤖 Loading specialist: {specialist}': '🤖 正在加载专家: {specialist}',
  '📚 Loading {context}…': '📚 正在加载{context}…',

  'general conversation': '一般对话',
  'server availability': '服务器可用性',
  'server procurement': '服务器采购',
  'account or billing': '账户或账单',
  'validator deployment': '验证者部署',
  'validator operations': '验证者运维',
  'RPC deployment': 'RPC 部署',
  'RPC operations': 'RPC 运维',
  'benchmark or connectivity testing': '基准测试或连通性测试',
  'app or bot development': '应用或机器人开发',
  'CLI or file operation': 'CLI 或文件操作',
  'needs clarification': '需要澄清',

  'account availability': '账户信息',
  'testnet validator inventory': 'testnet 验证者清单',
  'mainnet validator inventory': 'mainnet 验证者清单',
  'mainnet RPC inventory': 'mainnet RPC 清单',

  'Saving session memory...': '正在保存会话记忆...',
  'Conversation cleared.': '会话已清空。',
  '✅ versions.yml updated successfully!': '✅ versions.yml 更新成功！',
  'No pending updates.': '没有待应用的更新。',

  '/exit, /quit — Exit': '/exit, /quit — 退出',
  '/clear — Clear conversation': '/clear — 清空会话',
  '/update — Apply pending version updates': '/update — 应用待处理的版本更新',
  "/focus <validator|rpc|app|mixed|auto> — Switch or reset the main agent's primary focus":
    '/focus <validator|rpc|app|mixed|auto> — 切换或重置主代理的主要焦点',
  '/<command> — Execute shell command directly (e.g. /slv ai usage)':
    '/<command> — 直接执行 shell 命令（例如 /slv ai usage）',
  '/help — Show this help': '/help — 显示本帮助',

  'Current focus: {focus} (manual override)': '当前焦点: {focus}（手动覆盖）',
  'Current focus: {focus} (auto)': '当前焦点: {focus}（自动）',
  '⚠ Could not detect current focus: {error}':
    '⚠ 无法检测当前焦点: {error}',
  'Usage: /focus validator | rpc | app | mixed | auto':
    '用法: /focus validator | rpc | app | mixed | auto',
  '◇ Focus override cleared.': '◇ 已清除焦点覆盖。',
  '⚠ Failed to clear focus override: {error}': '⚠ 清除焦点覆盖失败: {error}',
  '◇ Focus set to: {focus}': '◇ 焦点已设置为: {focus}',
  '⚠ Failed to set focus: {error}': '⚠ 设置焦点失败: {error}',
  'Unknown focus "{focus}". Use: validator | rpc | app | mixed | auto':
    '未知焦点 "{focus}"。请使用: validator | rpc | app | mixed | auto',
  '⚠ Profile refresh failed: {error}': '⚠ 配置刷新失败: {error}',

  '⏳ {agent} is still working ({elapsed} elapsed).':
    '⏳ {agent} 仍在工作中（已耗时 {elapsed}）。',
  ' Validator deployment can take 20-40 minutes — building Solana, downloading snapshots, and configuring the node.':
    ' 验证者部署可能需要 20-40 分钟 — 构建 Solana、下载快照以及配置节点。',
  ' RPC deployment can take 30-60 minutes — building Solana, syncing with the cluster.':
    ' RPC 部署可能需要 30-60 分钟 — 构建 Solana 并与集群同步。',
  ' Benchmark and connectivity checks usually finish faster, but larger throughput tests can still take a few minutes.':
    ' 基准测试与连通性检查通常很快完成，但较大的吞吐测试仍可能需要数分钟。',
  ' Checking server availability and preparing your options.':
    ' 正在检查服务器可用性并准备候选方案。',
  " I'll let you know as soon as it's done!": ' 完成后我会立即通知您！',
  'The system': '系统',
  'a moment': '片刻',

  '⚠️  Missing dependencies: {deps}': '⚠️  缺少依赖: {deps}',
  'Install now? (Y/n) ': '现在安装? (Y/n) ',
  'Skipping installation. Some features may not work.':
    '已跳过安装。部分功能可能无法使用。',
  'Installing ansible-core...': '正在安装 ansible-core...',
  'Installing python3-pip...': '正在安装 python3-pip...',
  '✗ Could not install python3-pip. Please install manually: sudo apt-get install -y python3-pip':
    '✗ 无法安装 python3-pip。请手动安装: sudo apt-get install -y python3-pip',
  '✓ ansible-core installed': '✓ ansible-core 安装完成',
  'Installing solana-cli (agave)...': '正在安装 solana-cli (agave)...',
  '✓ solana-cli installed': '✓ solana-cli 安装完成',

  'SLV API Key not found. Run `slv login` first.':
    '未找到 SLV API 密钥。请先运行 `slv login`。',
  'Checking for new versions…': '正在检查新版本…',
  '🔄 New versions available:': '🔄 有新版本可用:',
  'Type /update to apply, or ignore to keep current versions.':
    '输入 /update 应用更新，或忽略以保持当前版本。',

  '⚡ Running command': '⚡ 执行命令',
  '📄 Reading file': '📄 读取文件',
  '📝 Writing file': '📝 写入文件',
  '📂 Listing files': '📂 列出文件',
  '🔗 Calling SLV Cloud API': '🔗 调用 SLV Cloud API',
  'inspect or operate the local/remote SLV environment':
    '检查或操作本地 / 远程 SLV 环境',
  'inspect focused local SLV files': '检查相关本地 SLV 文件',
  'check subscriptions or fetch SLV Cloud data':
    '检查订阅或获取 SLV Cloud 数据',
  'save configuration or update memory': '保存配置或更新记忆',
  'inspect available files before acting': '操作前检查可用文件',
  'notify you when a long task finishes': '在长任务完成时通知您',
  'hand work to a specialist agent': '移交工作给专家代理',

  '(exit code {code})': '(退出码 {code})',
  'Error: {message}': '错误: {message}',

  'Force exit.': '强制退出。',
  '⚠️ Interrupted. Press Ctrl+C again to exit, or type a message.':
    '⚠️ 已中断。再次按 Ctrl+C 退出，或输入消息。',

  // --- 网关浏览器聊天界面 ---
  'Send': '发送',
  'Stop': '停止',
  'clear': '清除',
  'Connect': '连接',
  'Clear chat history': '清除聊天记录',
  'Paste your gateway token': '粘贴网关令牌',
  "This browser is reaching the SLV gateway from a different host. Paste the gateway token value (found in ~/.slv/gateway/gateway.json on the gateway host) to continue. It's saved in your browser's localStorage.":
    '此浏览器正从其他主机访问 SLV 网关。请粘贴网关主机上 ~/.slv/gateway/gateway.json 中的 token 值以继续。将保存在浏览器的 localStorage 中。',
  'Type a message and press Enter': '输入消息并按 Enter 发送',
  '64 hex characters': '64 个十六进制字符',
  'You': '你',
  'Assistant': '助手',
  'Thinking…': '思考中…',
  'connecting…': '连接中…',
  'reconnecting…': '重连中…',
  'reconnecting in {secs}s…': '{secs} 秒后重连…',
  'connected': '已连接',
  'disconnected': '已断开',
  'connection error': '连接错误',
  'token required': '需要令牌',
  'handshake failed': '握手失败',
  'auth failed — check token': '认证失败 — 请检查令牌',
  '⏸ aborted': '⏸ 已中止',
  '❌ error': '❌ 错误',
  '[disconnected — reply interrupted]': '[已断开 — 回复被中断]',

  // --- 引导: Discord webhook 帮助 + 网关安装 ---
  'How to create a Discord webhook (30-sec video): https://youtube.com/shorts/2w-Afr_JVEg':
    '如何创建 Discord Webhook（30秒视频）: https://youtube.com/shorts/2w-Afr_JVEg',
  'Paste the webhook URL below, or press Enter to skip.':
    '请在下方粘贴 Webhook URL，或按 Enter 跳过。',
  'Browser chat UI (optional)': '浏览器聊天界面（可选）',
  'Installs a background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.':
    '安装后台服务，无需保持终端打开即可在浏览器中访问 http://127.0.0.1:{port}/ui/ 与 SLV 聊天。',
  'Not supported on this platform — skipped.':
    '此平台不支持 — 已跳过。',
  'Could not probe gateway status:': '无法查询网关状态:',
  'Gateway is already running at http://127.0.0.1:{port}/ui/':
    '网关已在 http://127.0.0.1:{port}/ui/ 运行',
  'Install and start the gateway now?':
    '现在安装并启动网关吗？',
  'Skipped. Run `slv gateway install && slv gateway start` later to enable the browser UI.':
    '已跳过。稍后运行 `slv gateway install && slv gateway start` 即可启用浏览器 UI。',
  'Gateway install failed — run `slv gateway install` manually to retry.':
    '网关安装失败 — 请手动运行 `slv gateway install` 重试。',
  'Service unit already installed — starting it.':
    '服务单元已安装 — 正在启动。',
  'Gateway start failed:': '网关启动失败:',
  'Run `slv gateway start` manually to retry.':
    '请手动运行 `slv gateway start` 重试。',
  'Gateway running at http://127.0.0.1:{port}/ui/':
    '网关运行于 http://127.0.0.1:{port}/ui/',
  'Gateway is already running.': '网关已在运行。',
  'Enable remote IP access (recommended for VPS)?':
    '启用 IP 远程访问吗？（VPS 推荐）',
  'Binds the gateway to 0.0.0.0 so you can open http://<server-ip>:{port}/ui/ directly from your phone/laptop. Token auth still gates every chat action.':
    '将网关绑定到 0.0.0.0，您可以直接从手机/笔记本打开 http://<server-ip>:{port}/ui/。所有聊天操作仍需令牌认证。',
  'Next step: once onboard finishes, run `slv c` and ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Video walkthrough: coming soon.':
    '下一步：引导完成后运行 `slv c`，请 SLV AI 帮您配置防火墙（nftables）和手机 WireGuard。视频教程即将发布。',
  'Enable remote IP access now?': '现在启用 IP 远程访问吗？',
  'Remote IP access enabled — gateway restarted.':
    'IP 远程访问已启用 — 网关已重启。',
  'Failed to enable remote IP access:': 'IP 远程访问启用失败:',
  'You can run `slv gateway config set-mode lan` later.':
    '稍后可运行 `slv gateway config set-mode lan`。',
  'Kept loopback-only. Run `slv gateway config set-mode lan` later to enable remote access.':
    '已保留仅回环访问。稍后运行 `slv gateway config set-mode lan` 即可启用远程访问。',

  // Discord 完成通知
  'SLV AI setup complete!': 'SLV AI 设置完成!',
  'Open SLV in your browser:': '在浏览器中打开 SLV:',
  'Gateway token (paste on first visit):':
    '网关令牌（首次访问时粘贴）:',
  'Security: ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Run `slv c` to start.':
    '安全提醒: 运行 `slv c`，请 SLV AI 帮您配置防火墙（nftables）和手机 WireGuard。',
  'Video walkthrough: coming soon.': '视频教程：即将发布。',
  'Loopback-only mode — open the URL from elsewhere via SSH tunnel first:':
    '仅回环模式 — 从其他地方打开 URL 前，请先建立 SSH 隧道:',
  'Sent browser UI link to your Discord webhook.':
    '已将浏览器 UI 链接发送到您的 Discord Webhook。',
  'Discord webhook post returned': 'Discord Webhook 响应:',
  'Check the webhook URL in ~/.slv/api.yml.':
    '请检查 ~/.slv/api.yml 中的 Webhook URL。',
  'Could not reach Discord webhook:': '无法连接 Discord Webhook:',
}
