export const messages: Record<string, string> = {
  'SLV AI Onboarding': 'Настройка SLV AI',
  'Select your language': 'Выберите язык',
  'Language saved. Please run `slv onboard` again to continue.':
    'Язык сохранён. Пожалуйста, запустите `slv onboard` снова, чтобы продолжить.',

  'Security warning — please read.': 'Предупреждение о безопасности — прочтите.',
  'SLV AI Console can execute commands on your system.':
    'SLV AI Console может выполнять команды в вашей системе.',
  'A bad prompt can trick it into doing unsafe things.':
    'Вредоносный запрос может заставить его выполнить небезопасные действия.',
  'Recommended:': 'Рекомендуется:',
  "- Don't paste untrusted prompts.": '- Не вставляйте непроверенные запросы.',
  '- `slv bot init` ships a Solana transaction sample designed to be improved with your AI before real use. When using real SOL, assets may decrease — use at your own risk.':
    '- `slv bot init` предоставляет образец транзакций Solana, который предполагается доработать вашим ИИ перед реальным использованием. При использовании настоящих SOL активы могут уменьшиться — используйте на свой страх и риск.',
  '- Keep secrets out of the conversation.':
    '- Не включайте секреты в диалог.',
  'I understand this is powerful and inherently risky. Continue?':
    'Я понимаю, что это мощный и рискованный инструмент. Продолжить?',
  'Yes': 'Да',
  'No': 'Нет',
  'Setup cancelled.': 'Настройка отменена.',

  'SLV API Key': 'SLV API ключ',
  'Get your free API key: https://discord.gg/S2gEbJTGJA':
    'Получите бесплатный API-ключ: https://discord.gg/S2gEbJTGJA',
  '🔑 SLV API Key (or press Enter to skip)':
    '🔑 SLV API ключ (Enter чтобы пропустить)',
  'SLV API Key saved.': 'SLV API ключ сохранён.',
  'Skipped. You can run `slv login` later.':
    'Пропущено. Вы можете позже запустить `slv login`.',
  'Using SLV AI (powered by your SLV API Key).':
    'Используется SLV AI (на базе вашего SLV API ключа).',

  'Agent Setup': 'Настройка агента',
  'Your name': 'Ваше имя',
  'Name is required': 'Имя обязательно',
  'What should the AI call you?': 'Как ИИ должен к вам обращаться?',
  'Name your main AI agent': 'Имя главного ИИ-агента',
  'What will you be doing? (↑↓ move, Space toggle, Enter confirm)':
    'Чем вы будете заниматься? (↑↓ перемещение, Space выбор, Enter подтверждение)',
  'Deployment mode': 'Режим развёртывания',
  'Local — deploy to this machine': 'Локально — развернуть на этой машине',
  'Remote — deploy to remote servers via SSH':
    'Удалённо — развернуть на удалённые серверы через SSH',

  'GitHub Setup (optional)': 'Настройка GitHub (необязательно)',
  'GitHub CLI already authenticated.': 'GitHub CLI уже авторизован.',
  'GitHub CLI (gh) not found. Install it from https://cli.github.com/':
    'GitHub CLI (gh) не найден. Установите с https://cli.github.com/',
  'Skipped. You can set up GitHub later.':
    'Пропущено. Вы можете настроить GitHub позже.',
  'Set up GitHub authentication? (enables repo creation, PRs, etc.)':
    'Настроить аутентификацию GitHub? (создание репозиториев, PR и т.д.)',
  'Yes — run gh auth login': 'Да — запустить gh auth login',
  'Skip for now': 'Пропустить пока',
  'Running `gh auth login`...': 'Запуск `gh auth login`...',
  'GitHub authenticated.': 'GitHub авторизован.',
  'GitHub authentication failed. You can retry with `gh auth login`.':
    'Ошибка аутентификации GitHub. Повторите с `gh auth login`.',
  'Skipped. You can run `gh auth login` later.':
    'Пропущено. Вы можете позже запустить `gh auth login`.',

  'Notifications (optional)': 'Уведомления (необязательно)',
  'Discord Webhook URL for notifications (Enter to skip)':
    'Discord Webhook URL для уведомлений (Enter чтобы пропустить)',
  'Discord Webhook saved to ~/.slv/api.yml':
    'Discord Webhook сохранён в ~/.slv/api.yml',
  'Skipped.': 'Пропущено.',

  'Agent files saved to ~/.slv/agent/':
    'Файлы агента сохранены в ~/.slv/agent/',
  'AI configuration saved to ~/.slv/api.yml':
    'Конфигурация ИИ сохранена в ~/.slv/api.yml',
  'Agent:': 'Агент:',
  'Run `slv c` to start the AI console.':
    'Запустите `slv c`, чтобы открыть консоль ИИ.',

  'slv bot init — trade-app is an example only':
    'slv bot init — trade-app является лишь примером',
  'The trade-app template is only an example of Solana on-chain transaction detection and submission. When the app starts, a wallet.json is created; trading begins once you deposit SOL into it, and your assets may decrease. Use this sample as a base for your own AI-assisted improvements — it can greatly reduce the effort of building Solana apps, but it is powerful and may cause financial loss in some cases.':
    'Шаблон trade-app — это лишь пример обнаружения и отправки транзакций в сети Solana. При запуске приложения создаётся wallet.json; торговля начинается после того, как вы внесёте на него SOL, и ваши средства могут уменьшиться. Используйте этот пример как основу для доработки вашим ИИ — это значительно сократит усилия по созданию Solana-приложений. Однако он очень мощный и в некоторых случаях может привести к финансовым потерям.',
  'I understand the above and will use it at my own risk.':
    'Я понимаю вышеуказанное и использую это на свой страх и риск.',
  'bot init cancelled. You can run `slv bot init` again when ready.':
    'bot init отменён. Вы можете запустить `slv bot init` снова, когда будете готовы.',

  'SLV AI Console': 'SLV AI Консоль',
  'Provider:': 'Провайдер:',
  'Model:': 'Модель:',
  'Type /exit to quit, /clear to reset. Press Enter to send.':
    'Введите /exit для выхода, /clear для сброса. Нажмите Enter для отправки.',
  'Hey there! 👋': 'Привет! 👋',
  'Hey {name}! 👋': 'Привет, {name}! 👋',
  "I'm {agent}, your SLV commander.": 'Я {agent}, ваш SLV командир.',
  "I'm your SLV assistant.": 'Я ваш SLV ассистент.',
  "Here's my crew:": 'Вот моя команда:',
  'What would you like to work on today?':
    'Над чем хотите поработать сегодня?',
  'Solana Validator deployments & management':
    'Развёртывание и управление валидаторами Solana',
  'RPC nodes (Index RPC, gRPC Geyser, combos)':
    'RPC-узлы (Index RPC, gRPC Geyser, комбо)',
  'Trading bots & Solana apps': 'Торговые боты и приложения Solana',
  'Find optimized Solana server resources':
    'Поиск оптимальных серверных ресурсов Solana',
  'Benchmarks & connectivity testing':
    'Бенчмарки и тестирование соединения',
  'Goodbye!': 'До свидания!',

  "Focused on Solana App Development. Say 'new trade bot' when you're ready.":
    'Фокус на разработке Solana-приложений. Скажите "new trade bot", когда будете готовы.',
  'Focused on App Development. You have 1 trade app: {name}.':
    'Фокус на разработке приложений. У вас 1 торговое приложение: {name}.',
  'Focused on App Development. You have {count} trade apps in ~/slv/.':
    'Фокус на разработке приложений. В ~/slv/ находится {count} торговых приложений.',
  'Focused on Solana Validator Operations. Ask me about deploys, health, or upgrades.':
    'Фокус на эксплуатации Solana-валидаторов. Спрашивайте о развёртываниях, здоровье и обновлениях.',
  'Focused on RPC / gRPC Node Operations. Ask me about endpoint setup, health, or tuning.':
    'Фокус на эксплуатации RPC / gRPC узлов. Спрашивайте о настройке эндпоинтов, здоровье и тюнинге.',
  'Mixed focus — validator + app / rpc. Use /focus <validator|rpc|app> to narrow.':
    'Смешанный фокус — validator + app / rpc. Используйте `/focus <validator|rpc|app>`, чтобы сузить.',
}
