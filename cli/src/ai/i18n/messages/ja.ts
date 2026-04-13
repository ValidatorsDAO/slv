export const messages: Record<string, string> = {
  'SLV AI Onboarding': 'SLV AI オンボーディング',
  'Select your language': '言語を選択してください',
  'Language saved. Please run `slv onboard` again to continue.':
    '言語を保存しました。もう一度 `slv onboard` を実行してください。',

  'Security warning — please read.': 'セキュリティに関する注意 — 必ずお読みください。',
  'SLV AI Console can execute commands on your system.':
    'SLV AI Console はあなたのシステム上でコマンドを実行できます。',
  'A bad prompt can trick it into doing unsafe things.':
    '悪意あるプロンプトにより、危険な動作を引き起こす可能性があります。',
  'Recommended:': '推奨事項:',
  "- Don't paste untrusted prompts.": '- 信頼できないプロンプトを貼り付けないでください。',
  '- `slv bot init` ships a Solana transaction sample designed to be improved with your AI before real use. When using real SOL, assets may decrease — use at your own risk.':
    '- `slv bot init` のテンプレは Solana トランザクションのサンプルです。お手元の AI で改善して使う前提でご利用ください。実際に SOL を利用する場合、資産が減ることがあるリスクを理解した上で使用してください。',
  '- Keep secrets out of the conversation.':
    '- 会話の中に機密情報を含めないでください。',
  'I understand this is powerful and inherently risky. Continue?':
    'これは強力でリスクを伴うことを理解しました。続行しますか？',
  'Yes': 'はい',
  'No': 'いいえ',
  'Setup cancelled.': 'セットアップを中止しました。',

  'SLV API Key': 'SLV API キー',
  'Get your free API key: https://discord.gg/S2gEbJTGJA':
    '無料 API キーの取得: https://discord.gg/S2gEbJTGJA',
  '🔑 SLV API Key (or press Enter to skip)':
    '🔑 SLV API キー（Enter でスキップ）',
  'SLV API Key saved.': 'SLV API キーを保存しました。',
  'Skipped. You can run `slv login` later.':
    'スキップしました。後で `slv login` を実行できます。',
  'Using SLV AI (powered by your SLV API Key).':
    'SLV AI を使用します（SLV API キーで動作）。',

  'Agent Setup': 'エージェント設定',
  'Your name': 'あなたの名前',
  'Name is required': '名前は必須です',
  'What should the AI call you?': 'AI に何と呼ばれたいですか？',
  'Name your main AI agent': 'メイン AI エージェントの名前',
  'What will you be doing? (↑↓ move, Space toggle, Enter confirm)':
    '何に使いますか？（↑↓ 移動、Space 選択、Enter 確定）',
  'Deployment mode': 'デプロイモード',
  'Local — deploy to this machine': 'ローカル — このマシンにデプロイ',
  'Remote — deploy to remote servers via SSH':
    'リモート — SSH 経由でリモートサーバーにデプロイ',

  'GitHub Setup (optional)': 'GitHub 設定（任意）',
  'GitHub CLI already authenticated.': 'GitHub CLI は既に認証済みです。',
  'GitHub CLI (gh) not found. Install it from https://cli.github.com/':
    'GitHub CLI (gh) が見つかりません。https://cli.github.com/ からインストールしてください。',
  'Skipped. You can set up GitHub later.':
    'スキップしました。後で GitHub を設定できます。',
  'Set up GitHub authentication? (enables repo creation, PRs, etc.)':
    'GitHub 認証を設定しますか？（リポジトリ作成、PR などが可能に）',
  'Yes — run gh auth login': 'はい — `gh auth login` を実行',
  'Skip for now': '今はスキップ',
  'Running `gh auth login`...': '`gh auth login` を実行中...',
  'GitHub authenticated.': 'GitHub 認証完了。',
  'GitHub authentication failed. You can retry with `gh auth login`.':
    'GitHub 認証に失敗しました。`gh auth login` で再試行してください。',
  'Skipped. You can run `gh auth login` later.':
    'スキップしました。後で `gh auth login` を実行できます。',

  'Notifications (optional)': '通知設定（任意）',
  'Discord Webhook URL for notifications (Enter to skip)':
    '通知用 Discord Webhook URL（Enter でスキップ）',
  'Discord Webhook saved to ~/.slv/api.yml':
    'Discord Webhook を ~/.slv/api.yml に保存しました',
  'Skipped.': 'スキップしました。',

  'Agent files saved to ~/.slv/agent/':
    'エージェントファイルを ~/.slv/agent/ に保存しました',
  'AI configuration saved to ~/.slv/api.yml':
    'AI 設定を ~/.slv/api.yml に保存しました',
  'Agent:': 'エージェント:',
  'Run `slv c` to start the AI console.':
    'AI コンソールを起動するには `slv c` を実行してください。',

  'slv bot init — trade-app is an example only':
    'slv bot init — trade-app はサンプルです',
  'The trade-app template is only an example of Solana on-chain transaction detection and submission. When the app starts, a wallet.json is created; trading begins once you deposit SOL into it, and your assets may decrease. Use this sample as a base for your own AI-assisted improvements — it can greatly reduce the effort of building Solana apps, but it is powerful and may cause financial loss in some cases.':
    'trade-app はあくまでも Solana チェーンを使ったトランザクションの検知・送信などの例です。アプリを起動したときに wallet.json が作成され、そこに SOL をデポジットすることでトレードが始まり、資産が減る場合があることを理解してください。このサンプルをもとにお手元の AI で改善を進めることで、Solana アプリ構築の手間を大幅に削減できるはずです。しかし、これはとてもパワフルで、場合によっては資産を減らすことがあることを理解してください。',
  'I understand the above and will use it at my own risk.':
    '上記のことを理解した上で使用します。',
  'bot init cancelled. You can run `slv bot init` again when ready.':
    'bot init を中止しました。準備ができたら再度 `slv bot init` を実行してください。',

  'SLV AI Console': 'SLV AI コンソール',
  'Provider:': 'プロバイダー:',
  'Model:': 'モデル:',
  'Type /exit to quit, /clear to reset. Press Enter to send.':
    '/exit で終了、/clear でリセット。Enter で送信します。',
  'Hey there! 👋': 'こんにちは！👋',
  'Hey {name}! 👋': 'こんにちは、{name}さん！👋',
  "I'm {agent}, your SLV commander.": '私は {agent}、あなたの SLV コマンダーです。',
  "I'm your SLV assistant.": '私はあなたの SLV アシスタントです。',
  "Here's my crew:": '私のクルーを紹介します:',
  'What would you like to work on today?':
    '今日は何を進めましょうか？',
  'Solana Validator deployments & management':
    'Solana バリデータのデプロイと管理',
  'RPC nodes (Index RPC, gRPC Geyser, combos)':
    'RPC ノード (Index RPC、gRPC Geyser、組み合わせ)',
  'Trading bots & Solana apps': 'トレードボットと Solana アプリ',
  'Find optimized Solana server resources':
    '最適な Solana サーバーリソースの調達',
  'Benchmarks & connectivity testing': 'ベンチマークと接続性テスト',
  'Goodbye!': 'さようなら！',

  "Focused on Solana App Development. Say 'new trade bot' when you're ready.":
    'Solana アプリ開発にフォーカス中。準備ができたら「new trade bot」と言ってください。',
  'Focused on App Development. You have 1 trade app: {name}.':
    'アプリ開発にフォーカス中。トレードアプリが 1 つあります: {name}。',
  'Focused on App Development. You have {count} trade apps in ~/slv/.':
    'アプリ開発にフォーカス中。~/slv/ にトレードアプリが {count} 個あります。',
  'Focused on Solana Validator Operations. Ask me about deploys, health, or upgrades.':
    'Solana バリデータ運用にフォーカス中。デプロイ、ヘルスチェック、アップグレードなどご相談ください。',
  'Focused on RPC / gRPC Node Operations. Ask me about endpoint setup, health, or tuning.':
    'RPC / gRPC ノード運用にフォーカス中。エンドポイント設定、ヘルス、チューニングなどご相談ください。',
  'Mixed focus — validator + app / rpc. Use /focus <validator|rpc|app> to narrow.':
    '複数の役割にフォーカス中 — validator + app / rpc。`/focus <validator|rpc|app>` で絞り込めます。',
}
