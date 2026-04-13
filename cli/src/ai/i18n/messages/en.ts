// English is the source of truth. Keys are the same as values so callers can
// write `t('Some English text')` and fall back cleanly when no translation exists.

export const messages: Record<string, string> = {
  // --- Onboard ---
  'SLV AI Onboarding': 'SLV AI Onboarding',
  'Select your language': 'Select your language',
  'Language saved. Please run `slv onboard` again to continue.':
    'Language saved. Please run `slv onboard` again to continue.',

  'Security warning — please read.': 'Security warning — please read.',
  'SLV AI Console can execute commands on your system.':
    'SLV AI Console can execute commands on your system.',
  'A bad prompt can trick it into doing unsafe things.':
    'A bad prompt can trick it into doing unsafe things.',
  'Recommended:': 'Recommended:',
  "- Don't paste untrusted prompts.": "- Don't paste untrusted prompts.",
  '- `slv bot init` ships a Solana transaction sample designed to be improved with your AI before real use. When using real SOL, assets may decrease — use at your own risk.':
    '- `slv bot init` ships a Solana transaction sample designed to be improved with your AI before real use. When using real SOL, assets may decrease — use at your own risk.',
  '- Keep secrets out of the conversation.':
    '- Keep secrets out of the conversation.',
  'I understand this is powerful and inherently risky. Continue?':
    'I understand this is powerful and inherently risky. Continue?',
  'Yes': 'Yes',
  'No': 'No',
  'Setup cancelled.': 'Setup cancelled.',

  'SLV API Key': 'SLV API Key',
  'Get your free API key: https://discord.gg/S2gEbJTGJA':
    'Get your free API key: https://discord.gg/S2gEbJTGJA',
  '🔑 SLV API Key (or press Enter to skip)':
    '🔑 SLV API Key (or press Enter to skip)',
  'SLV API Key saved.': 'SLV API Key saved.',
  'Skipped. You can run `slv login` later.':
    'Skipped. You can run `slv login` later.',
  'Using SLV AI (powered by your SLV API Key).':
    'Using SLV AI (powered by your SLV API Key).',

  'Agent Setup': 'Agent Setup',
  'Your name': 'Your name',
  'Name is required': 'Name is required',
  'What should the AI call you?': 'What should the AI call you?',
  'Name your main AI agent': 'Name your main AI agent',
  'What will you be doing? (↑↓ move, Space toggle, Enter confirm)':
    'What will you be doing? (↑↓ move, Space toggle, Enter confirm)',
  'Deployment mode': 'Deployment mode',
  'Local — deploy to this machine': 'Local — deploy to this machine',
  'Remote — deploy to remote servers via SSH':
    'Remote — deploy to remote servers via SSH',

  'GitHub Setup (optional)': 'GitHub Setup (optional)',
  'GitHub CLI already authenticated.': 'GitHub CLI already authenticated.',
  'GitHub CLI (gh) not found. Install it from https://cli.github.com/':
    'GitHub CLI (gh) not found. Install it from https://cli.github.com/',
  'Skipped. You can set up GitHub later.':
    'Skipped. You can set up GitHub later.',
  'Set up GitHub authentication? (enables repo creation, PRs, etc.)':
    'Set up GitHub authentication? (enables repo creation, PRs, etc.)',
  'Yes — run gh auth login': 'Yes — run gh auth login',
  'Skip for now': 'Skip for now',
  'Running `gh auth login`...': 'Running `gh auth login`...',
  'GitHub authenticated.': 'GitHub authenticated.',
  'GitHub authentication failed. You can retry with `gh auth login`.':
    'GitHub authentication failed. You can retry with `gh auth login`.',
  'Skipped. You can run `gh auth login` later.':
    'Skipped. You can run `gh auth login` later.',

  'Notifications (optional)': 'Notifications (optional)',
  'Discord Webhook URL for notifications (Enter to skip)':
    'Discord Webhook URL for notifications (Enter to skip)',
  'Discord Webhook saved to ~/.slv/api.yml':
    'Discord Webhook saved to ~/.slv/api.yml',
  'Skipped.': 'Skipped.',

  'Agent files saved to ~/.slv/agent/':
    'Agent files saved to ~/.slv/agent/',
  'AI configuration saved to ~/.slv/api.yml':
    'AI configuration saved to ~/.slv/api.yml',
  'Agent:': 'Agent:',
  'Run `slv c` to start the AI console.':
    'Run `slv c` to start the AI console.',

  // --- Bot init agreement ---
  'slv bot init — trade-app is an example only':
    'slv bot init — trade-app is an example only',
  'The trade-app template is only an example of Solana on-chain transaction detection and submission. When the app starts, a wallet.json is created; trading begins once you deposit SOL into it, and your assets may decrease. Use this sample as a base for your own AI-assisted improvements — it can greatly reduce the effort of building Solana apps, but it is powerful and may cause financial loss in some cases.':
    'The trade-app template is only an example of Solana on-chain transaction detection and submission. When the app starts, a wallet.json is created; trading begins once you deposit SOL into it, and your assets may decrease. Use this sample as a base for your own AI-assisted improvements — it can greatly reduce the effort of building Solana apps, but it is powerful and may cause financial loss in some cases.',
  'I understand the above and will use it at my own risk.':
    'I understand the above and will use it at my own risk.',
  'bot init cancelled. You can run `slv bot init` again when ready.':
    'bot init cancelled. You can run `slv bot init` again when ready.',

  // --- AI Console ---
  'SLV AI Console': 'SLV AI Console',
  'Provider:': 'Provider:',
  'Model:': 'Model:',
  'Type /exit to quit, /clear to reset. Press Enter to send.':
    'Type /exit to quit, /clear to reset. Press Enter to send.',
  'Hey there! 👋': 'Hey there! 👋',
  'Hey {name}! 👋': 'Hey {name}! 👋',
  "I'm {agent}, your SLV commander.": "I'm {agent}, your SLV commander.",
  "I'm your SLV assistant.": "I'm your SLV assistant.",
  "Here's my crew:": "Here's my crew:",
  'What would you like to work on today?':
    'What would you like to work on today?',
  'Solana Validator deployments & management':
    'Solana Validator deployments & management',
  'RPC nodes (Index RPC, gRPC Geyser, combos)':
    'RPC nodes (Index RPC, gRPC Geyser, combos)',
  'Trading bots & Solana apps': 'Trading bots & Solana apps',
  'Find optimized Solana server resources':
    'Find optimized Solana server resources',
  'Benchmarks & connectivity testing': 'Benchmarks & connectivity testing',
  'Goodbye!': 'Goodbye!',

  // --- User profile (role detection) ---
  "Focused on Solana App Development. Say 'new trade bot' when you're ready.":
    "Focused on Solana App Development. Say 'new trade bot' when you're ready.",
  'Focused on App Development. You have 1 trade app: {name}.':
    'Focused on App Development. You have 1 trade app: {name}.',
  'Focused on App Development. You have {count} trade apps in ~/slv/.':
    'Focused on App Development. You have {count} trade apps in ~/slv/.',
  'Focused on Solana Validator Operations. Ask me about deploys, health, or upgrades.':
    'Focused on Solana Validator Operations. Ask me about deploys, health, or upgrades.',
  'Focused on RPC / gRPC Node Operations. Ask me about endpoint setup, health, or tuning.':
    'Focused on RPC / gRPC Node Operations. Ask me about endpoint setup, health, or tuning.',
  'Mixed focus — validator + app / rpc. Use /focus <validator|rpc|app> to narrow.':
    'Mixed focus — validator + app / rpc. Use /focus <validator|rpc|app> to narrow.',
}
