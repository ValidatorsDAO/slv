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

  '👂 Understanding your request…': '👂 ご依頼内容を確認しています…',
  'Understanding your request...': 'ご依頼内容を確認しています...',
  '🎓 Intent detected: {intent}': '🎓 意図を検出: {intent}',
  '🧰 Enabling tools: {tools}': '🧰 ツールを有効化: {tools}',
  '📚 Loading context: {modules}': '📚 コンテキストを読み込み中: {modules}',
  '🤖 Loading specialist: {specialist}': '🤖 スペシャリストを起動中: {specialist}',
  '📚 Loading {context}…': '📚 {context}を読み込み中…',

  'general conversation': '一般的な会話',
  'server availability': 'サーバー空き状況',
  'server procurement': 'サーバー調達',
  'account or billing': 'アカウント / 請求',
  'validator deployment': 'バリデータのデプロイ',
  'validator operations': 'バリデータ運用',
  'RPC deployment': 'RPC デプロイ',
  'RPC operations': 'RPC 運用',
  'benchmark or connectivity testing': 'ベンチマーク / 接続テスト',
  'app or bot development': 'アプリ / ボット開発',
  'CLI or file operation': 'CLI / ファイル操作',
  'needs clarification': '要確認',

  'account availability': 'アカウント情報',
  'testnet validator inventory': 'testnet バリデータ一覧',
  'mainnet validator inventory': 'mainnet バリデータ一覧',
  'mainnet RPC inventory': 'mainnet RPC 一覧',

  'Saving session memory...': 'セッションメモリを保存中...',
  'Conversation cleared.': '会話をクリアしました。',
  '✅ versions.yml updated successfully!': '✅ versions.yml を更新しました！',
  'No pending updates.': '適用可能なアップデートはありません。',

  '/exit, /quit — Exit': '/exit, /quit — 終了',
  '/clear — Clear conversation': '/clear — 会話をクリア',
  '/update — Apply pending version updates':
    '/update — 保留中のバージョン更新を適用',
  "/focus <validator|rpc|app|mixed|auto> — Switch or reset the main agent's primary focus":
    '/focus <validator|rpc|app|mixed|auto> — メインエージェントのフォーカスを切り替え / リセット',
  '/<command> — Execute shell command directly (e.g. /slv ai usage)':
    '/<command> — シェルコマンドを直接実行（例: /slv ai usage）',
  '/help — Show this help': '/help — このヘルプを表示',

  'Current focus: {focus} (manual override)':
    '現在のフォーカス: {focus}（手動設定）',
  'Current focus: {focus} (auto)': '現在のフォーカス: {focus}（自動検出）',
  '⚠ Could not detect current focus: {error}':
    '⚠ 現在のフォーカスを検出できませんでした: {error}',
  'Usage: /focus validator | rpc | app | mixed | auto':
    '使い方: /focus validator | rpc | app | mixed | auto',
  '◇ Focus override cleared.': '◇ フォーカスの手動設定を解除しました。',
  '⚠ Failed to clear focus override: {error}':
    '⚠ フォーカス設定の解除に失敗しました: {error}',
  '◇ Focus set to: {focus}': '◇ フォーカスを設定: {focus}',
  '⚠ Failed to set focus: {error}': '⚠ フォーカス設定に失敗しました: {error}',
  'Unknown focus "{focus}". Use: validator | rpc | app | mixed | auto':
    '不明なフォーカス "{focus}"。次を使用してください: validator | rpc | app | mixed | auto',
  '⚠ Profile refresh failed: {error}': '⚠ プロフィール再読み込みに失敗: {error}',

  '⏳ {agent} is still working ({elapsed} elapsed).':
    '⏳ {agent} は作業中です（経過: {elapsed}）。',
  ' Validator deployment can take 20-40 minutes — building Solana, downloading snapshots, and configuring the node.':
    ' バリデータのデプロイには 20〜40 分かかることがあります — Solana のビルド、スナップショットのダウンロード、ノードの設定を行います。',
  ' RPC deployment can take 30-60 minutes — building Solana, syncing with the cluster.':
    ' RPC のデプロイには 30〜60 分かかることがあります — Solana のビルドとクラスタ同期を行います。',
  ' Benchmark and connectivity checks usually finish faster, but larger throughput tests can still take a few minutes.':
    ' ベンチマークや接続性テストは比較的すぐに終わりますが、大きめのスループットテストでは数分かかることがあります。',
  ' Checking server availability and preparing your options.':
    ' サーバー空き状況を確認し、候補を準備しています。',
  " I'll let you know as soon as it's done!": ' 完了次第お知らせします！',
  'The system': 'システム',
  'a moment': '少し前',

  '⚠️  Missing dependencies: {deps}': '⚠️  不足している依存関係: {deps}',
  'Install now? (Y/n) ': '今すぐインストールしますか？ (Y/n) ',
  'Skipping installation. Some features may not work.':
    'インストールをスキップしました。一部機能が動作しないことがあります。',
  'Installing ansible-core...': 'ansible-core をインストール中...',
  'Installing python3-pip...': 'python3-pip をインストール中...',
  '✗ Could not install python3-pip. Please install manually: sudo apt-get install -y python3-pip':
    '✗ python3-pip をインストールできませんでした。手動でインストールしてください: sudo apt-get install -y python3-pip',
  '✓ ansible-core installed': '✓ ansible-core をインストールしました',
  'Installing solana-cli (agave)...': 'solana-cli (agave) をインストール中...',
  '✓ solana-cli installed': '✓ solana-cli をインストールしました',

  'SLV API Key not found. Run `slv login` first.':
    'SLV API キーが見つかりません。先に `slv login` を実行してください。',
  'Checking for new versions…': '新しいバージョンを確認中…',
  '🔄 New versions available:': '🔄 新しいバージョンが利用可能です:',
  'Type /update to apply, or ignore to keep current versions.':
    '適用するには /update を入力、現在のバージョンを維持する場合は無視してください。',

  '⚡ Running command': '⚡ コマンド実行',
  '📄 Reading file': '📄 ファイル読み込み',
  '📝 Writing file': '📝 ファイル書き込み',
  '📂 Listing files': '📂 ファイル一覧',
  '🔗 Calling SLV Cloud API': '🔗 SLV Cloud API 呼び出し',
  'inspect or operate the local/remote SLV environment':
    'ローカル / リモートの SLV 環境を確認・操作',
  'inspect focused local SLV files': '関連するローカル SLV ファイルを確認',
  'check subscriptions or fetch SLV Cloud data':
    'サブスクリプションの確認や SLV Cloud データの取得',
  'save configuration or update memory': '設定の保存やメモリの更新',
  'inspect available files before acting': '実行前に対象ファイルを確認',
  'notify you when a long task finishes':
    '長時間タスクの完了をお知らせ',
  'hand work to a specialist agent': 'スペシャリストエージェントへ引き継ぎ',

  '(exit code {code})': '(終了コード {code})',
  'Error: {message}': 'エラー: {message}',

  'Force exit.': '強制終了します。',
  '⚠️ Interrupted. Press Ctrl+C again to exit, or type a message.':
    '⚠️ 中断しました。もう一度 Ctrl+C で終了、またはメッセージを入力してください。',

  // --- ゲートウェイのブラウザチャット UI ---
  'Send': '送信',
  'Stop': '停止',
  'clear': 'クリア',
  'Connect': '接続',
  'Clear chat history': 'チャット履歴を消去',
  'Paste your gateway token': 'ゲートウェイトークンを貼り付けてください',
  "This browser is reaching the SLV gateway from a different host. Paste the gateway token value (found in ~/.slv/gateway/gateway.json on the gateway host) to continue. It's saved in your browser's localStorage.":
    'このブラウザは別ホストから SLV ゲートウェイへアクセスしています。ゲートウェイホストの ~/.slv/gateway/gateway.json にある token の値を貼り付けて続行してください。ブラウザの localStorage に保存されます。',
  'Type a message and press Enter': 'メッセージを入力して Enter で送信',
  '64 hex characters': '64 文字の 16 進数',
  'You': 'あなた',
  'Assistant': 'アシスタント',
  'Thinking…': '考えています…',
  'connecting…': '接続中…',
  'reconnecting…': '再接続中…',
  'reconnecting in {secs}s…': '{secs} 秒後に再接続…',
  'connected': '接続済み',
  'disconnected': '切断されました',
  'connection error': '接続エラー',
  'token required': 'トークンが必要です',
  'handshake failed': 'ハンドシェイクに失敗しました',
  'auth failed — check token': '認証失敗 — トークンを確認してください',
  '⏸ aborted': '⏸ 中断',
  '❌ error': '❌ エラー',
  '[disconnected — reply interrupted]': '[切断されました — 応答が中断されました]',

  // --- オンボード: Discord webhook ヘルプ + ゲートウェイインストール ---
  'How to create a Discord webhook (30-sec video): https://youtube.com/shorts/2w-Afr_JVEg':
    'Discord Webhook の作り方（30秒動画）: https://youtube.com/shorts/2w-Afr_JVEg',
  'Paste the webhook URL below, or press Enter to skip.':
    '下の欄に Webhook URL を貼り付けてください。スキップするなら Enter を押してください。',
  'Browser chat UI (optional)': 'ブラウザチャット UI（オプション）',
  'Installs a background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.':
    'バックグラウンドサービスをインストールして、ターミナルを開いたままにしなくてもブラウザから http://127.0.0.1:{port}/ui/ で SLV とチャットできるようにします。',
  'Not supported on this platform — skipped.':
    'このプラットフォームでは対応していません — スキップします。',
  'Could not probe gateway status:': 'ゲートウェイの状態を取得できませんでした:',
  'Gateway is already running at http://127.0.0.1:{port}/ui/':
    'ゲートウェイは既に http://127.0.0.1:{port}/ui/ で起動しています',
  'Install and start the gateway now?':
    'ゲートウェイを今すぐインストールして起動しますか？',
  'Skipped. Run `slv gateway install && slv gateway start` later to enable the browser UI.':
    'スキップしました。ブラウザ UI を有効にしたくなったら `slv gateway install && slv gateway start` を実行してください。',
  'Gateway install failed — run `slv gateway install` manually to retry.':
    'ゲートウェイのインストールに失敗しました — `slv gateway install` を手動で実行して再試行してください。',
  'Service unit already installed — starting it.':
    'サービスユニットは既にインストール済み — 起動します。',
  'Gateway start failed:': 'ゲートウェイの起動に失敗しました:',
  'Run `slv gateway start` manually to retry.':
    '`slv gateway start` を手動で実行して再試行してください。',
  'Gateway running at http://127.0.0.1:{port}/ui/':
    'ゲートウェイが http://127.0.0.1:{port}/ui/ で稼働中',
}
