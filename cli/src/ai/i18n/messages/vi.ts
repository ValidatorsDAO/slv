export const messages: Record<string, string> = {
  'SLV AI Onboarding': 'Cài đặt SLV AI',
  'Select your language': 'Chọn ngôn ngữ của bạn',
  'Language saved. Please run `slv onboard` again to continue.':
    'Đã lưu ngôn ngữ. Vui lòng chạy lại `slv onboard` để tiếp tục.',

  'Security warning — please read.': 'Cảnh báo bảo mật — vui lòng đọc.',
  'SLV AI Console can execute commands on your system.':
    'SLV AI Console có thể thực thi lệnh trên hệ thống của bạn.',
  'A bad prompt can trick it into doing unsafe things.':
    'Một prompt xấu có thể khiến nó thực hiện những việc không an toàn.',
  'Recommended:': 'Khuyến nghị:',
  "- Don't paste untrusted prompts.": '- Không dán các prompt không đáng tin cậy.',
  '- `slv bot init` ships a Solana transaction sample designed to be improved with your AI before real use. When using real SOL, assets may decrease — use at your own risk.':
    '- `slv bot init` cung cấp mẫu giao dịch Solana, được thiết kế để bạn cải tiến bằng AI của mình trước khi sử dụng thực tế. Khi dùng SOL thật, tài sản có thể giảm — vui lòng tự chịu rủi ro khi sử dụng.',
  '- Keep secrets out of the conversation.':
    '- Không đưa thông tin bí mật vào hội thoại.',
  'I understand this is powerful and inherently risky. Continue?':
    'Tôi hiểu điều này mạnh mẽ và tiềm ẩn rủi ro. Tiếp tục?',
  'Yes': 'Có',
  'No': 'Không',
  'Setup cancelled.': 'Đã hủy cài đặt.',

  'SLV API Key': 'Khóa SLV API',
  'Get your free API key: https://discord.gg/S2gEbJTGJA':
    'Nhận khóa API miễn phí: https://discord.gg/S2gEbJTGJA',
  '🔑 SLV API Key (or press Enter to skip)':
    '🔑 Khóa SLV API (nhấn Enter để bỏ qua)',
  'SLV API Key saved.': 'Đã lưu khóa SLV API.',
  'Skipped. You can run `slv login` later.':
    'Đã bỏ qua. Bạn có thể chạy `slv login` sau.',
  'Using SLV AI (powered by your SLV API Key).':
    'Đang sử dụng SLV AI (dùng khóa SLV API của bạn).',

  'Agent Setup': 'Cài đặt Agent',
  'Your name': 'Tên của bạn',
  'Name is required': 'Tên là bắt buộc',
  'What should the AI call you?': 'AI nên gọi bạn là gì?',
  'Name your main AI agent': 'Đặt tên cho AI agent chính',
  'What will you be doing? (↑↓ move, Space toggle, Enter confirm)':
    'Bạn sẽ làm gì? (↑↓ di chuyển, Space chọn, Enter xác nhận)',
  'Deployment mode': 'Chế độ triển khai',
  'Local — deploy to this machine': 'Local — triển khai trên máy này',
  'Remote — deploy to remote servers via SSH':
    'Remote — triển khai lên máy chủ từ xa qua SSH',

  'GitHub Setup (optional)': 'Cài đặt GitHub (tùy chọn)',
  'GitHub CLI already authenticated.': 'GitHub CLI đã được xác thực.',
  'GitHub CLI (gh) not found. Install it from https://cli.github.com/':
    'Không tìm thấy GitHub CLI (gh). Cài đặt từ https://cli.github.com/',
  'Skipped. You can set up GitHub later.':
    'Đã bỏ qua. Bạn có thể cài đặt GitHub sau.',
  'Set up GitHub authentication? (enables repo creation, PRs, etc.)':
    'Cài đặt xác thực GitHub? (cho phép tạo repo, PR, v.v.)',
  'Yes — run gh auth login': 'Có — chạy gh auth login',
  'Skip for now': 'Bỏ qua lúc này',
  'Running `gh auth login`...': 'Đang chạy `gh auth login`...',
  'GitHub authenticated.': 'GitHub đã được xác thực.',
  'GitHub authentication failed. You can retry with `gh auth login`.':
    'Xác thực GitHub thất bại. Bạn có thể thử lại với `gh auth login`.',
  'Skipped. You can run `gh auth login` later.':
    'Đã bỏ qua. Bạn có thể chạy `gh auth login` sau.',

  'Notifications (optional)': 'Thông báo (tùy chọn)',
  'Discord Webhook URL for notifications (Enter to skip)':
    'URL Discord Webhook cho thông báo (Enter để bỏ qua)',
  'Discord Webhook saved to ~/.slv/api.yml':
    'Đã lưu Discord Webhook vào ~/.slv/api.yml',
  'Skipped.': 'Đã bỏ qua.',

  'Agent files saved to ~/.slv/agent/':
    'Đã lưu tệp agent vào ~/.slv/agent/',
  'AI configuration saved to ~/.slv/api.yml':
    'Đã lưu cấu hình AI vào ~/.slv/api.yml',
  'Agent:': 'Agent:',
  'Run `slv c` to start the AI console.':
    'Chạy `slv c` để khởi động AI console.',

  'slv bot init — trade-app is an example only':
    'slv bot init — trade-app chỉ là ví dụ',
  'The trade-app template is only an example of Solana on-chain transaction detection and submission. When the app starts, a wallet.json is created; trading begins once you deposit SOL into it, and your assets may decrease. Use this sample as a base for your own AI-assisted improvements — it can greatly reduce the effort of building Solana apps, but it is powerful and may cause financial loss in some cases.':
    'Template trade-app chỉ là một ví dụ về việc phát hiện và gửi giao dịch trên chuỗi Solana. Khi ứng dụng khởi động, một wallet.json sẽ được tạo; giao dịch bắt đầu khi bạn nạp SOL vào đó, và tài sản của bạn có thể giảm. Hãy sử dụng ví dụ này làm nền tảng để cải tiến với AI của bạn — nó có thể giảm đáng kể công sức xây dựng ứng dụng Solana. Tuy nhiên, nó rất mạnh mẽ và trong một số trường hợp có thể gây thiệt hại tài chính.',
  'I understand the above and will use it at my own risk.':
    'Tôi hiểu những điều trên và sử dụng với rủi ro của bản thân.',
  'bot init cancelled. You can run `slv bot init` again when ready.':
    'Đã hủy bot init. Bạn có thể chạy lại `slv bot init` khi sẵn sàng.',

  'SLV AI Console': 'Bảng điều khiển SLV AI',
  'Provider:': 'Nhà cung cấp:',
  'Model:': 'Mô hình:',
  'Type /exit to quit, /clear to reset. Press Enter to send.':
    'Gõ /exit để thoát, /clear để đặt lại. Nhấn Enter để gửi.',
  'Hey there! 👋': 'Xin chào! 👋',
  'Hey {name}! 👋': 'Xin chào, {name}! 👋',
  "I'm {agent}, your SLV commander.": 'Tôi là {agent}, chỉ huy SLV của bạn.',
  "I'm your SLV assistant.": 'Tôi là trợ lý SLV của bạn.',
  "Here's my crew:": 'Đây là đội của tôi:',
  'What would you like to work on today?':
    'Hôm nay bạn muốn làm gì?',
  'Solana Validator deployments & management':
    'Triển khai & quản lý Solana Validator',
  'RPC nodes (Index RPC, gRPC Geyser, combos)':
    'Nút RPC (Index RPC, gRPC Geyser, kết hợp)',
  'Trading bots & Solana apps': 'Bot giao dịch & ứng dụng Solana',
  'Find optimized Solana server resources':
    'Tìm tài nguyên máy chủ Solana tối ưu',
  'Benchmarks & connectivity testing':
    'Kiểm thử hiệu năng & kết nối',
  'Goodbye!': 'Tạm biệt!',

  "Focused on Solana App Development. Say 'new trade bot' when you're ready.":
    'Đang tập trung vào phát triển ứng dụng Solana. Nói "new trade bot" khi bạn đã sẵn sàng.',
  'Focused on App Development. You have 1 trade app: {name}.':
    'Đang tập trung vào phát triển ứng dụng. Bạn có 1 trade app: {name}.',
  'Focused on App Development. You have {count} trade apps in ~/slv/.':
    'Đang tập trung vào phát triển ứng dụng. Bạn có {count} trade app trong ~/slv/.',
  'Focused on Solana Validator Operations. Ask me about deploys, health, or upgrades.':
    'Đang tập trung vào vận hành Solana Validator. Hỏi tôi về triển khai, health hoặc upgrade.',
  'Focused on RPC / gRPC Node Operations. Ask me about endpoint setup, health, or tuning.':
    'Đang tập trung vào vận hành node RPC / gRPC. Hỏi tôi về cấu hình endpoint, health hoặc tinh chỉnh.',
  'Mixed focus — validator + app / rpc. Use /focus <validator|rpc|app> to narrow.':
    'Focus hỗn hợp — validator + app / rpc. Dùng `/focus <validator|rpc|app>` để thu hẹp.',

  '👂 Understanding your request…': '👂 Đang hiểu yêu cầu của bạn…',
  'Understanding your request...': 'Đang hiểu yêu cầu của bạn...',
  '🎓 Intent detected: {intent}': '🎓 Đã phát hiện ý định: {intent}',
  '🧰 Enabling tools: {tools}': '🧰 Đang bật công cụ: {tools}',
  '📚 Loading context: {modules}': '📚 Đang tải ngữ cảnh: {modules}',
  '🤖 Loading specialist: {specialist}':
    '🤖 Đang tải chuyên gia: {specialist}',
  '📚 Loading {context}…': '📚 Đang tải {context}…',

  'general conversation': 'trò chuyện chung',
  'server availability': 'tình trạng sẵn có của máy chủ',
  'server procurement': 'mua sắm máy chủ',
  'account or billing': 'tài khoản hoặc thanh toán',
  'validator deployment': 'triển khai validator',
  'validator operations': 'vận hành validator',
  'RPC deployment': 'triển khai RPC',
  'RPC operations': 'vận hành RPC',
  'benchmark or connectivity testing': 'benchmark hoặc kiểm tra kết nối',
  'app or bot development': 'phát triển ứng dụng hoặc bot',
  'CLI or file operation': 'thao tác CLI hoặc tệp',
  'needs clarification': 'cần làm rõ',

  'account availability': 'thông tin tài khoản',
  'testnet validator inventory': 'danh sách validator testnet',
  'mainnet validator inventory': 'danh sách validator mainnet',
  'mainnet RPC inventory': 'danh sách RPC mainnet',

  'Saving session memory...': 'Đang lưu bộ nhớ phiên...',
  'Conversation cleared.': 'Đã xóa cuộc hội thoại.',
  '✅ versions.yml updated successfully!':
    '✅ versions.yml đã được cập nhật thành công!',
  'No pending updates.': 'Không có bản cập nhật chờ xử lý.',

  '/exit, /quit — Exit': '/exit, /quit — Thoát',
  '/clear — Clear conversation': '/clear — Xóa cuộc hội thoại',
  '/update — Apply pending version updates':
    '/update — Áp dụng bản cập nhật phiên bản đang chờ',
  "/focus <validator|rpc|app|mixed|auto> — Switch or reset the main agent's primary focus":
    '/focus <validator|rpc|app|mixed|auto> — Chuyển hoặc đặt lại focus chính của agent chính',
  '/<command> — Execute shell command directly (e.g. /slv ai usage)':
    '/<command> — Thực thi lệnh shell trực tiếp (ví dụ /slv ai usage)',
  '/help — Show this help': '/help — Hiển thị trợ giúp này',

  'Current focus: {focus} (manual override)':
    'Focus hiện tại: {focus} (đặt thủ công)',
  'Current focus: {focus} (auto)': 'Focus hiện tại: {focus} (tự động)',
  '⚠ Could not detect current focus: {error}':
    '⚠ Không thể phát hiện focus hiện tại: {error}',
  'Usage: /focus validator | rpc | app | mixed | auto':
    'Cách dùng: /focus validator | rpc | app | mixed | auto',
  '◇ Focus override cleared.': '◇ Đã xóa focus đặt thủ công.',
  '⚠ Failed to clear focus override: {error}':
    '⚠ Không thể xóa focus đặt thủ công: {error}',
  '◇ Focus set to: {focus}': '◇ Đã đặt focus thành: {focus}',
  '⚠ Failed to set focus: {error}': '⚠ Không thể đặt focus: {error}',
  'Unknown focus "{focus}". Use: validator | rpc | app | mixed | auto':
    'Focus không xác định "{focus}". Dùng: validator | rpc | app | mixed | auto',
  '⚠ Profile refresh failed: {error}':
    '⚠ Làm mới hồ sơ thất bại: {error}',

  '⏳ {agent} is still working ({elapsed} elapsed).':
    '⏳ {agent} vẫn đang làm việc (đã trôi qua {elapsed}).',
  ' Validator deployment can take 20-40 minutes — building Solana, downloading snapshots, and configuring the node.':
    ' Triển khai validator có thể mất 20-40 phút — biên dịch Solana, tải snapshot và cấu hình node.',
  ' RPC deployment can take 30-60 minutes — building Solana, syncing with the cluster.':
    ' Triển khai RPC có thể mất 30-60 phút — biên dịch Solana và đồng bộ với cluster.',
  ' Benchmark and connectivity checks usually finish faster, but larger throughput tests can still take a few minutes.':
    ' Benchmark và kiểm tra kết nối thường nhanh hơn, nhưng các bài kiểm tra throughput lớn vẫn có thể mất vài phút.',
  ' Checking server availability and preparing your options.':
    ' Đang kiểm tra máy chủ sẵn có và chuẩn bị lựa chọn cho bạn.',
  " I'll let you know as soon as it's done!":
    ' Tôi sẽ báo cho bạn ngay khi xong!',
  'The system': 'Hệ thống',
  'a moment': 'một lát',

  '⚠️  Missing dependencies: {deps}': '⚠️  Thiếu phụ thuộc: {deps}',
  'Install now? (Y/n) ': 'Cài đặt ngay? (Y/n) ',
  'Skipping installation. Some features may not work.':
    'Đã bỏ qua cài đặt. Một số tính năng có thể không hoạt động.',
  'Installing ansible-core...': 'Đang cài đặt ansible-core...',
  'Installing python3-pip...': 'Đang cài đặt python3-pip...',
  '✗ Could not install python3-pip. Please install manually: sudo apt-get install -y python3-pip':
    '✗ Không thể cài đặt python3-pip. Vui lòng cài đặt thủ công: sudo apt-get install -y python3-pip',
  '✓ ansible-core installed': '✓ Đã cài đặt ansible-core',
  'Installing solana-cli (agave)...': 'Đang cài đặt solana-cli (agave)...',
  '✓ solana-cli installed': '✓ Đã cài đặt solana-cli',

  'SLV API Key not found. Run `slv login` first.':
    'Không tìm thấy khóa SLV API. Vui lòng chạy `slv login` trước.',
  'Checking for new versions…': 'Đang kiểm tra phiên bản mới…',
  '🔄 New versions available:': '🔄 Đã có phiên bản mới:',
  'Type /update to apply, or ignore to keep current versions.':
    'Gõ /update để áp dụng, hoặc bỏ qua để giữ phiên bản hiện tại.',

  '⚡ Running command': '⚡ Đang chạy lệnh',
  '📄 Reading file': '📄 Đang đọc tệp',
  '📝 Writing file': '📝 Đang ghi tệp',
  '📂 Listing files': '📂 Liệt kê tệp',
  '🔗 Calling SLV Cloud API': '🔗 Đang gọi SLV Cloud API',
  'inspect or operate the local/remote SLV environment':
    'kiểm tra hoặc vận hành môi trường SLV cục bộ / từ xa',
  'inspect focused local SLV files': 'kiểm tra tệp SLV cục bộ liên quan',
  'check subscriptions or fetch SLV Cloud data':
    'kiểm tra đăng ký hoặc lấy dữ liệu SLV Cloud',
  'save configuration or update memory': 'lưu cấu hình hoặc cập nhật bộ nhớ',
  'inspect available files before acting':
    'kiểm tra tệp có sẵn trước khi thực hiện',
  'notify you when a long task finishes':
    'thông báo khi tác vụ dài hoàn tất',
  'hand work to a specialist agent':
    'chuyển công việc cho agent chuyên trách',

  '(exit code {code})': '(mã thoát {code})',
  'Error: {message}': 'Lỗi: {message}',

  'Force exit.': 'Thoát bắt buộc.',
  '⚠️ Interrupted. Press Ctrl+C again to exit, or type a message.':
    '⚠️ Đã ngắt. Nhấn Ctrl+C lần nữa để thoát, hoặc nhập tin nhắn.',

  // --- Giao diện chat trình duyệt của cổng ---
  'Send': 'Gửi',
  'Stop': 'Dừng',
  'clear': 'xóa',
  'Connect': 'Kết nối',
  'Clear chat history': 'Xóa lịch sử trò chuyện',
  'Paste your gateway token': 'Dán token cổng',
  "This browser is reaching the SLV gateway from a different host. Paste the gateway token value (found in ~/.slv/gateway/gateway.json on the gateway host) to continue. It's saved in your browser's localStorage.":
    'Trình duyệt này đang truy cập cổng SLV từ host khác. Dán giá trị token trong ~/.slv/gateway/gateway.json trên host cổng để tiếp tục. Sẽ được lưu trong localStorage của trình duyệt.',
  'Type a message and press Enter': 'Nhập tin nhắn và nhấn Enter',
  '64 hex characters': '64 ký tự hex',
  'You': 'Bạn',
  'Assistant': 'Trợ lý',
  'Thinking…': 'Đang suy nghĩ…',
  'connecting…': 'đang kết nối…',
  'reconnecting…': 'đang kết nối lại…',
  'reconnecting in {secs}s…': 'kết nối lại sau {secs} giây…',
  'connected': 'đã kết nối',
  'disconnected': 'đã ngắt kết nối',
  'connection error': 'lỗi kết nối',
  'token required': 'cần token',
  'handshake failed': 'bắt tay thất bại',
  'auth failed — check token': 'xác thực thất bại — kiểm tra token',
  '⏸ aborted': '⏸ đã hủy',
  '❌ error': '❌ lỗi',
  '[disconnected — reply interrupted]': '[đã ngắt kết nối — phản hồi bị gián đoạn]',
}
