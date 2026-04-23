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
  'First, tell the AI `set up the firewall` — we recommend hardening security next.':
    'First, tell the AI `set up the firewall` — we recommend hardening security next.',

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

  // --- Console stages (shown after user input) ---
  '👂 Understanding your request…': '👂 Understanding your request…',
  'Understanding your request...': 'Understanding your request...',
  '🎓 Intent detected: {intent}': '🎓 Intent detected: {intent}',
  '🧰 Enabling tools: {tools}': '🧰 Enabling tools: {tools}',
  '📚 Loading context: {modules}': '📚 Loading context: {modules}',
  '🤖 Loading specialist: {specialist}': '🤖 Loading specialist: {specialist}',
  '📚 Loading {context}…': '📚 Loading {context}…',

  // --- Intent labels (used inside stage messages) ---
  'general conversation': 'general conversation',
  'server availability': 'server availability',
  'server procurement': 'server procurement',
  'account or billing': 'account or billing',
  'validator deployment': 'validator deployment',
  'validator operations': 'validator operations',
  'RPC deployment': 'RPC deployment',
  'RPC operations': 'RPC operations',
  'benchmark or connectivity testing': 'benchmark or connectivity testing',
  'app or bot development': 'app or bot development',
  'CLI or file operation': 'CLI or file operation',
  'needs clarification': 'needs clarification',

  // --- User context kind labels (used inside stage messages) ---
  'account availability': 'account availability',
  'testnet validator inventory': 'testnet validator inventory',
  'mainnet validator inventory': 'mainnet validator inventory',
  'mainnet RPC inventory': 'mainnet RPC inventory',

  // --- Console commands & status ---
  'Saving session memory...': 'Saving session memory...',
  'Conversation cleared.': 'Conversation cleared.',
  '✅ versions.yml updated successfully!':
    '✅ versions.yml updated successfully!',
  'No pending updates.': 'No pending updates.',

  // --- /help ---
  '/exit, /quit — Exit': '/exit, /quit — Exit',
  '/clear — Clear conversation': '/clear — Clear conversation',
  '/update — Apply pending version updates':
    '/update — Apply pending version updates',
  "/focus <validator|rpc|app|mixed|auto> — Switch or reset the main agent's primary focus":
    "/focus <validator|rpc|app|mixed|auto> — Switch or reset the main agent's primary focus",
  '/<command> — Execute shell command directly (e.g. /slv ai usage)':
    '/<command> — Execute shell command directly (e.g. /slv ai usage)',
  '/help — Show this help': '/help — Show this help',

  // --- /focus ---
  'Current focus: {focus} (manual override)':
    'Current focus: {focus} (manual override)',
  'Current focus: {focus} (auto)': 'Current focus: {focus} (auto)',
  '⚠ Could not detect current focus: {error}':
    '⚠ Could not detect current focus: {error}',
  'Usage: /focus validator | rpc | app | mixed | auto':
    'Usage: /focus validator | rpc | app | mixed | auto',
  '◇ Focus override cleared.': '◇ Focus override cleared.',
  '⚠ Failed to clear focus override: {error}':
    '⚠ Failed to clear focus override: {error}',
  '◇ Focus set to: {focus}': '◇ Focus set to: {focus}',
  '⚠ Failed to set focus: {error}': '⚠ Failed to set focus: {error}',
  'Unknown focus "{focus}". Use: validator | rpc | app | mixed | auto':
    'Unknown focus "{focus}". Use: validator | rpc | app | mixed | auto',
  '⚠ Profile refresh failed: {error}': '⚠ Profile refresh failed: {error}',

  // --- Side-chat agent status (shown while another task is running) ---
  '⏳ {agent} is still working ({elapsed} elapsed).':
    '⏳ {agent} is still working ({elapsed} elapsed).',
  ' Validator deployment can take 20-40 minutes — building Solana, downloading snapshots, and configuring the node.':
    ' Validator deployment can take 20-40 minutes — building Solana, downloading snapshots, and configuring the node.',
  ' RPC deployment can take 30-60 minutes — building Solana, syncing with the cluster.':
    ' RPC deployment can take 30-60 minutes — building Solana, syncing with the cluster.',
  ' Benchmark and connectivity checks usually finish faster, but larger throughput tests can still take a few minutes.':
    ' Benchmark and connectivity checks usually finish faster, but larger throughput tests can still take a few minutes.',
  ' Checking server availability and preparing your options.':
    ' Checking server availability and preparing your options.',
  " I'll let you know as soon as it's done!":
    " I'll let you know as soon as it's done!",
  'The system': 'The system',
  'a moment': 'a moment',

  // --- Dependency installation ---
  '⚠️  Missing dependencies: {deps}': '⚠️  Missing dependencies: {deps}',
  'Install now? (Y/n) ': 'Install now? (Y/n) ',
  'Skipping installation. Some features may not work.':
    'Skipping installation. Some features may not work.',
  'Installing ansible-core...': 'Installing ansible-core...',
  'Installing python3-pip...': 'Installing python3-pip...',
  '✗ Could not install python3-pip. Please install manually: sudo apt-get install -y python3-pip':
    '✗ Could not install python3-pip. Please install manually: sudo apt-get install -y python3-pip',
  '✓ ansible-core installed': '✓ ansible-core installed',
  'Installing solana-cli (agave)...': 'Installing solana-cli (agave)...',
  '✓ solana-cli installed': '✓ solana-cli installed',

  // --- Startup guard / version check ---
  'SLV API Key not found. Run `slv login` first.':
    'SLV API Key not found. Run `slv login` first.',
  'Checking for new versions…': 'Checking for new versions…',
  '🔄 New versions available:': '🔄 New versions available:',
  'Type /update to apply, or ignore to keep current versions.':
    'Type /update to apply, or ignore to keep current versions.',

  // --- Tool call labels (addTool) ---
  '⚡ Running command': '⚡ Running command',
  '📄 Reading file': '📄 Reading file',
  '📝 Writing file': '📝 Writing file',
  '📂 Listing files': '📂 Listing files',
  '🔗 Calling SLV Cloud API': '🔗 Calling SLV Cloud API',
  'inspect or operate the local/remote SLV environment':
    'inspect or operate the local/remote SLV environment',
  'inspect focused local SLV files': 'inspect focused local SLV files',
  'check subscriptions or fetch SLV Cloud data':
    'check subscriptions or fetch SLV Cloud data',
  'save configuration or update memory':
    'save configuration or update memory',
  'inspect available files before acting':
    'inspect available files before acting',
  'notify you when a long task finishes':
    'notify you when a long task finishes',
  'hand work to a specialist agent': 'hand work to a specialist agent',

  // --- Shell execution / errors ---
  '(exit code {code})': '(exit code {code})',
  'Error: {message}': 'Error: {message}',

  // --- Ctrl+C handler ---
  'Force exit.': 'Force exit.',
  '⚠️ Interrupted. Press Ctrl+C again to exit, or type a message.':
    '⚠️ Interrupted. Press Ctrl+C again to exit, or type a message.',

  // --- Gateway browser chat UI ---
  'Send': 'Send',
  'Stop': 'Stop',
  'clear': 'clear',
  'Connect': 'Connect',
  'Clear chat history': 'Clear chat history',
  'Paste your gateway token': 'Paste your gateway token',
  "This browser is reaching the SLV gateway from a different host. Paste the gateway token value (found in ~/.slv/gateway/gateway.json on the gateway host) to continue. It's saved in your browser's localStorage.":
    "This browser is reaching the SLV gateway from a different host. Paste the gateway token value (found in ~/.slv/gateway/gateway.json on the gateway host) to continue. It's saved in your browser's localStorage.",
  'Type a message and press Enter': 'Type a message and press Enter',
  '64 hex characters': '64 hex characters',
  'You': 'You',
  'Assistant': 'Assistant',
  'Thinking…': 'Thinking…',
  'connecting…': 'connecting…',
  'reconnecting…': 'reconnecting…',
  'reconnecting in {secs}s…': 'reconnecting in {secs}s…',
  'connected': 'connected',
  'disconnected': 'disconnected',
  'connection error': 'connection error',
  'token required': 'token required',
  'handshake failed': 'handshake failed',
  'auth failed — check token': 'auth failed — check token',
  '⏸ aborted': '⏸ aborted',
  '❌ error': '❌ error',
  '[disconnected — reply interrupted]': '[disconnected — reply interrupted]',

  // --- Onboard: Discord webhook help + gateway install ---
  'How to create a Discord webhook (30-sec video): https://youtube.com/shorts/2w-Afr_JVEg':
    'How to create a Discord webhook (30-sec video): https://youtube.com/shorts/2w-Afr_JVEg',
  'Paste the webhook URL below, or press Enter to skip.':
    'Paste the webhook URL below, or press Enter to skip.',
  'Browser chat UI (optional)': 'Browser chat UI (optional)',
  'Installs a background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.':
    'Installs a background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.',
  'Not supported on this platform — skipped.':
    'Not supported on this platform — skipped.',
  'Could not probe gateway status:': 'Could not probe gateway status:',
  'Gateway is already running at http://127.0.0.1:{port}/ui/':
    'Gateway is already running at http://127.0.0.1:{port}/ui/',
  'Install and start the gateway now?': 'Install and start the gateway now?',
  'Skipped. Run `slv gateway install && slv gateway start` later to enable the browser UI.':
    'Skipped. Run `slv gateway install && slv gateway start` later to enable the browser UI.',
  'Gateway install failed — run `slv gateway install` manually to retry.':
    'Gateway install failed — run `slv gateway install` manually to retry.',
  'Service unit already installed — starting it.':
    'Service unit already installed — starting it.',
  'Gateway start failed:': 'Gateway start failed:',
  'Run `slv gateway start` manually to retry.':
    'Run `slv gateway start` manually to retry.',
  'Gateway running at http://127.0.0.1:{port}/ui/':
    'Gateway running at http://127.0.0.1:{port}/ui/',
  'Public HTTPS URL (optional)': 'Public HTTPS URL (optional)',
  'Point your free subdomain {fqdn} at this VPS and install nginx so SLV AI is reachable over HTTPS from your phone — no cert setup needed (Cloudflare handles TLS).':
    'Point your free subdomain {fqdn} at this VPS and install nginx so SLV AI is reachable over HTTPS from your phone — no cert setup needed (Cloudflare handles TLS).',
  'Set up HTTPS now?': 'Set up HTTPS now?',
  'Skipped. Run `slv install nginx` later to enable HTTPS.':
    'Skipped. Run `slv install nginx` later to enable HTTPS.',
  'HTTPS setup failed ({stage}): {err}':
    'HTTPS setup failed ({stage}): {err}',
  'You can retry later with `slv install nginx`.':
    'You can retry later with `slv install nginx`.',
  'HTTPS is live at {url}': 'HTTPS is live at {url}',
  'Skipped — SLV API key required. Run `slv login` then `slv install nginx` to enable HTTPS.':
    'Skipped — SLV API key required. Run `slv login` then `slv install nginx` to enable HTTPS.',
  'Could not read DNS status — run `slv install nginx` later to retry.':
    'Could not read DNS status — run `slv install nginx` later to retry.',
  'Browser chat UI':
    'Browser chat UI',
  'Installing the background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.':
    'Installing the background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.',
  'An SLV API key lets us point your free erpc.global subdomain at this VPS for instant HTTPS.':
    'An SLV API key lets us point your free erpc.global subdomain at this VPS for instant HTTPS.',
  '🔑 Paste your SLV API key here (Enter to skip HTTPS):':
    '🔑 Paste your SLV API key here (Enter to skip HTTPS):',
  'Skipped. Run `slv login` then `slv install nginx` later to enable HTTPS.':
    'Skipped. Run `slv login` then `slv install nginx` later to enable HTTPS.',
  '⚠ This VPS is NOT an SLV VPS / BareMetal.':
    '⚠ This VPS is NOT an SLV VPS / BareMetal.',
  'Falling back to plain HTTP (http://<ip>:20026/) — not encrypted. Treat this as dev-only. For production, provision an SLV VPS or BareMetal from the dashboard below; its IP gets registered automatically and HTTPS works on the next `slv install nginx`.':
    'Falling back to plain HTTP (http://<ip>:20026/) — not encrypted. Treat this as dev-only. For production, provision an SLV VPS or BareMetal from the dashboard below; its IP gets registered automatically and HTTPS works on the next `slv install nginx`.',
  '⚠ Your free subdomain {fqdn} is already pointing at {ip}.':
    '⚠ Your free subdomain {fqdn} is already pointing at {ip}.',
  'Re-pointing it here would break the other host. Each SLV account gets exactly one free subdomain; a second one requires the paid tier (coming soon) or a support ticket for edge cases.':
    'Re-pointing it here would break the other host. Each SLV account gets exactly one free subdomain; a second one requires the paid tier (coming soon) or a support ticket for edge cases.',
  'What would you like to do?': 'What would you like to do?',
  'Skip HTTPS for this VPS — leave the existing subdomain alone':
    'Skip HTTPS for this VPS — leave the existing subdomain alone',
  'Create a support ticket to request a 2nd subdomain':
    'Create a support ticket to request a 2nd subdomain',
  "Re-point anyway (breaks the other VPS — only choose if you know what you're doing)":
    "Re-point anyway (breaks the other VPS — only choose if you know what you're doing)",
  'Kept existing subdomain. You can run `slv install nginx` on the other VPS to reclaim if needed.':
    'Kept existing subdomain. You can run `slv install nginx` on the other VPS to reclaim if needed.',
  'Creating support ticket...': 'Creating support ticket...',
  'Ticket creation failed: {err}': 'Ticket creation failed: {err}',
  'Ticket opened. Follow up here:': 'Ticket opened. Follow up here:',
  'Security: tap the URL above to open SLV AI in your browser, and ask it to help you set up the firewall (nftables) and WireGuard (with the app on your phone). The conversation happens right there — no terminal needed.':
    'Security: tap the URL above to open SLV AI in your browser, and ask it to help you set up the firewall (nftables) and WireGuard (with the app on your phone). The conversation happens right there — no terminal needed.',
  'For automatic HTTPS + a free *.erpc.global subdomain, run SLV on an SLV VPS or BareMetal (provision via the dashboard):':
    'For automatic HTTPS + a free *.erpc.global subdomain, run SLV on an SLV VPS or BareMetal (provision via the dashboard):',
  'Gateway is already running.': 'Gateway is already running.',
  'Enable remote IP access (recommended for VPS)?':
    'Enable remote IP access (recommended for VPS)?',
  'Binds the gateway to 0.0.0.0 so you can open http://<server-ip>:{port}/ui/ directly from your phone/laptop. Token auth still gates every chat action.':
    'Binds the gateway to 0.0.0.0 so you can open http://<server-ip>:{port}/ui/ directly from your phone/laptop. Token auth still gates every chat action.',
  'Next step: once onboard finishes, run `slv c` and ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Video walkthrough: coming soon.':
    'Next step: once onboard finishes, run `slv c` and ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Video walkthrough: coming soon.',
  'Enable remote IP access now?': 'Enable remote IP access now?',
  'Remote IP access enabled — gateway restarted.':
    'Remote IP access enabled — gateway restarted.',
  'Failed to enable remote IP access:': 'Failed to enable remote IP access:',
  'You can run `slv gateway config set-mode lan` later.':
    'You can run `slv gateway config set-mode lan` later.',
  'Kept loopback-only. Run `slv gateway config set-mode lan` later to enable remote access.':
    'Kept loopback-only. Run `slv gateway config set-mode lan` later to enable remote access.',

  // Discord completion webhook
  'SLV AI setup complete!': 'SLV AI setup complete!',
  'Open SLV in your browser:': 'Open SLV in your browser:',
  'Gateway token (paste on first visit):':
    'Gateway token (paste on first visit):',
  'Security: ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Run `slv c` to start.':
    'Security: ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Run `slv c` to start.',
  'Video walkthrough: coming soon.': 'Video walkthrough: coming soon.',
  'Loopback-only mode — open the URL from elsewhere via SSH tunnel first:':
    'Loopback-only mode — open the URL from elsewhere via SSH tunnel first:',
  'Sent browser UI link to your Discord webhook.':
    'Sent browser UI link to your Discord webhook.',
  'Discord webhook post returned': 'Discord webhook post returned',
  'Check the webhook URL in ~/.slv/api.yml.':
    'Check the webhook URL in ~/.slv/api.yml.',
  'Could not reach Discord webhook:': 'Could not reach Discord webhook:',
}
