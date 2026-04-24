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
  'First, tell the AI `set up the firewall` — we recommend hardening security next.':
    'Trước tiên, hãy nói với AI "thiết lập tường lửa" — chúng tôi khuyến nghị tăng cường bảo mật tiếp theo.',

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

  // --- Đính kèm ảnh trong chat trình duyệt ---
  'Attach image': 'Đính kèm ảnh',
  'Drop images here to attach': 'Thả ảnh vào đây để đính kèm',
  'Remove image': 'Xóa ảnh',
  '📎 {n} image(s) attached': '📎 Đã đính kèm {n} ảnh',
  'Operation log': 'Nhật ký thao tác',
  'Consulting {agent}…': 'Đang hỏi {agent}…',
  'Running {tool}…': 'Đang chạy {tool}…',
  'Only JPEG, PNG, GIF, or WebP images are accepted.':
    'Chỉ chấp nhận ảnh JPEG / PNG / GIF / WebP.',
  'Image "{name}" is too large ({mb} MB). Max per image: {max} MB raw.':
    'Ảnh "{name}" quá lớn ({mb} MB). Tối đa mỗi ảnh: {max} MB.',
  'Too many images — max {max} per message.':
    'Quá nhiều ảnh — tối đa {max} mỗi tin nhắn.',
  'Attached images total {mb} MB; max {max} MB combined.':
    'Tổng kích thước ảnh đính kèm {mb} MB; tối đa tổng cộng {max} MB.',

  // --- Onboard: hướng dẫn Discord webhook + cài đặt cổng ---
  'How to create a Discord webhook (30-sec video): https://youtube.com/shorts/2w-Afr_JVEg':
    'Cách tạo Discord Webhook (video 30 giây): https://youtube.com/shorts/2w-Afr_JVEg',
  'Paste the webhook URL below, or press Enter to skip.':
    'Dán URL webhook bên dưới, hoặc nhấn Enter để bỏ qua.',
  'Browser chat UI (optional)': 'Giao diện chat trên trình duyệt (tùy chọn)',
  'Installs a background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.':
    'Cài dịch vụ chạy nền để bạn có thể trò chuyện với SLV từ trình duyệt tại http://127.0.0.1:{port}/ui/ mà không cần mở terminal.',
  'Not supported on this platform — skipped.':
    'Không hỗ trợ trên nền tảng này — đã bỏ qua.',
  'Could not probe gateway status:':
    'Không kiểm tra được trạng thái cổng:',
  'Gateway is already running at http://127.0.0.1:{port}/ui/':
    'Cổng đang chạy tại http://127.0.0.1:{port}/ui/',
  'Install and start the gateway now?':
    'Cài đặt và khởi động cổng ngay bây giờ?',
  'Skipped. Run `slv gateway install && slv gateway start` later to enable the browser UI.':
    'Đã bỏ qua. Chạy `slv gateway install && slv gateway start` sau để bật giao diện trình duyệt.',
  'Gateway install failed — run `slv gateway install` manually to retry.':
    'Cài đặt cổng thất bại — chạy `slv gateway install` thủ công để thử lại.',
  'Service unit already installed — starting it.':
    'Đơn vị dịch vụ đã được cài — đang khởi động.',
  'Gateway start failed:': 'Khởi động cổng thất bại:',
  'Run `slv gateway start` manually to retry.':
    'Chạy `slv gateway start` thủ công để thử lại.',
  'Gateway running at http://127.0.0.1:{port}/ui/':
    'Cổng đang chạy tại http://127.0.0.1:{port}/ui/',
  'Public HTTPS URL (optional)': 'URL HTTPS công khai (tùy chọn)',
  'Point your free subdomain {fqdn} at this VPS and install nginx so SLV AI is reachable over HTTPS from your phone — no cert setup needed (Cloudflare handles TLS).':
    'Trỏ subdomain miễn phí {fqdn} của bạn đến VPS này và cài nginx để SLV AI có thể truy cập qua HTTPS từ điện thoại — không cần cài chứng chỉ (Cloudflare xử lý TLS).',
  'Set up HTTPS now?': 'Cài đặt HTTPS ngay?',
  'Skipped. Run `slv install nginx` later to enable HTTPS.':
    'Đã bỏ qua. Chạy `slv install nginx` sau để bật HTTPS.',
  'HTTPS setup failed ({stage}): {err}':
    'Cài đặt HTTPS thất bại ({stage}): {err}',
  'You can retry later with `slv install nginx`.':
    'Bạn có thể thử lại sau với `slv install nginx`.',
  'HTTPS is live at {url}': 'HTTPS đang hoạt động tại {url}',
  'Skipped — SLV API key required. Run `slv login` then `slv install nginx` to enable HTTPS.':
    'Đã bỏ qua — cần có SLV API key. Chạy `slv login` rồi `slv install nginx` để bật HTTPS.',
  'Could not read DNS status — run `slv install nginx` later to retry.':
    'Không đọc được trạng thái DNS — chạy `slv install nginx` sau để thử lại.',
  'Browser chat UI': 'Giao diện chat trình duyệt',
  'Installing the background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.':
    'Đang cài dịch vụ chạy nền để bạn có thể trò chuyện với SLV từ trình duyệt tại http://127.0.0.1:{port}/ui/ mà không cần mở terminal.',
  'An SLV API key lets us point your free erpc.global subdomain at this VPS for instant HTTPS.':
    'SLV API key cho phép trỏ subdomain erpc.global miễn phí của bạn đến VPS này để có HTTPS ngay.',
  '🔑 Paste your SLV API key here (Enter to skip HTTPS):':
    '🔑 Dán SLV API key tại đây (Enter để bỏ qua HTTPS):',
  'Skipped. Run `slv login` then `slv install nginx` later to enable HTTPS.':
    'Đã bỏ qua. Chạy `slv login` rồi `slv install nginx` sau để bật HTTPS.',
  '⚠ This VPS is NOT an SLV VPS / BareMetal.':
    '⚠ VPS này KHÔNG phải SLV VPS / BareMetal.',
  'Falling back to plain HTTP (http://<ip>:20026/) — not encrypted. Treat this as dev-only. For production, provision an SLV VPS or BareMetal from the dashboard below; its IP gets registered automatically and HTTPS works on the next `slv install nginx`.':
    'Chuyển sang HTTP thường (http://<ip>:20026/) — không mã hóa. Chỉ dùng cho dev. Với production, hãy tạo SLV VPS hoặc BareMetal từ dashboard bên dưới; IP sẽ tự động đăng ký và HTTPS hoạt động ở lần `slv install nginx` tiếp theo.',
  '⚠ Your free subdomain {fqdn} is already pointing at {ip}.':
    '⚠ Subdomain miễn phí {fqdn} của bạn đang trỏ đến {ip}.',
  'Re-pointing it here would break the other host. Each SLV account gets exactly one free subdomain; a second one requires the paid tier (coming soon) or a support ticket for edge cases.':
    'Trỏ lại ở đây sẽ làm hỏng host kia. Mỗi tài khoản SLV chỉ có 1 subdomain miễn phí; cái thứ 2 cần gói trả phí (sắp ra mắt) hoặc ticket hỗ trợ.',
  'What would you like to do?': 'Bạn muốn làm gì?',
  'Skip HTTPS for this VPS — leave the existing subdomain alone':
    'Bỏ qua HTTPS cho VPS này — giữ nguyên subdomain hiện có',
  'Create a support ticket to request a 2nd subdomain':
    'Tạo ticket hỗ trợ để xin subdomain thứ 2',
  "Re-point anyway (breaks the other VPS — only choose if you know what you're doing)":
    'Vẫn trỏ lại (làm hỏng VPS kia — chỉ chọn nếu bạn biết mình đang làm gì)',
  'Kept existing subdomain. You can run `slv install nginx` on the other VPS to reclaim if needed.':
    'Đã giữ subdomain hiện có. Nếu cần, chạy `slv install nginx` trên VPS kia để lấy lại.',
  'Creating support ticket...': 'Đang tạo ticket hỗ trợ…',
  'Ticket creation failed: {err}': 'Tạo ticket thất bại: {err}',
  'Ticket opened. Follow up here:': 'Đã mở ticket. Theo dõi tại:',
  'Security: tap the URL above to open SLV AI in your browser, and ask it to help you set up the firewall (nftables) and WireGuard (with the app on your phone). The conversation happens right there — no terminal needed.':
    'Bảo mật: chạm URL phía trên để mở SLV AI trong trình duyệt, rồi nhờ nó hướng dẫn cài firewall (nftables) và WireGuard (với app trên điện thoại). Trò chuyện ngay trong trình duyệt — không cần terminal.',
  'For automatic HTTPS + a free *.erpc.global subdomain, run SLV on an SLV VPS or BareMetal (provision via the dashboard):':
    'Để tự động có HTTPS và subdomain *.erpc.global miễn phí, hãy chạy SLV trên SLV VPS hoặc BareMetal (tạo qua dashboard):',
  'Gateway is already running.': 'Cổng đang chạy.',
  'Enable remote IP access (recommended for VPS)?':
    'Bật truy cập từ xa bằng IP? (khuyến nghị cho VPS)',
  'Binds the gateway to 0.0.0.0 so you can open http://<server-ip>:{port}/ui/ directly from your phone/laptop. Token auth still gates every chat action.':
    'Bind cổng vào 0.0.0.0 để bạn có thể mở http://<server-ip>:{port}/ui/ trực tiếp từ điện thoại/laptop. Mọi thao tác chat vẫn được bảo vệ bằng token.',
  'Next step: once onboard finishes, run `slv c` and ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Video walkthrough: coming soon.':
    'Bước tiếp theo: khi onboard hoàn tất, chạy `slv c` và nhờ SLV AI hướng dẫn cài firewall (nftables) và WireGuard (với app trên điện thoại). Video hướng dẫn sẽ có sau.',
  'Enable remote IP access now?': 'Bật truy cập từ xa bằng IP ngay?',
  'Remote IP access enabled — gateway restarted.':
    'Đã bật truy cập từ xa bằng IP — cổng được khởi động lại.',
  'Failed to enable remote IP access:':
    'Không thể bật truy cập từ xa bằng IP:',
  'You can run `slv gateway config set-mode lan` later.':
    'Bạn có thể chạy `slv gateway config set-mode lan` sau.',
  'Kept loopback-only. Run `slv gateway config set-mode lan` later to enable remote access.':
    'Giữ nguyên loopback. Chạy `slv gateway config set-mode lan` sau để bật truy cập từ xa.',

  // Thông báo hoàn tất qua Discord
  'SLV AI setup complete!': 'Cài đặt SLV AI hoàn tất!',
  'Open SLV in your browser:': 'Mở SLV trong trình duyệt:',
  'Gateway token (paste on first visit):':
    'Token cổng (dán khi truy cập lần đầu):',
  'Security: ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Run `slv c` to start.':
    'Bảo mật: chạy `slv c` và nhờ SLV AI hướng dẫn cài firewall (nftables) và WireGuard (với app trên điện thoại).',
  'Video walkthrough: coming soon.': 'Video hướng dẫn: sẽ có sau.',
  'Loopback-only mode — open the URL from elsewhere via SSH tunnel first:':
    'Chế độ chỉ loopback — Trước khi mở URL từ nơi khác, hãy tạo SSH tunnel trước:',
  'Sent browser UI link to your Discord webhook.':
    'Đã gửi liên kết giao diện trình duyệt đến Discord webhook của bạn.',
  'Discord webhook post returned': 'Phản hồi từ Discord webhook:',
  'Check the webhook URL in ~/.slv/api.yml.':
    'Kiểm tra URL webhook trong ~/.slv/api.yml.',
  'Could not reach Discord webhook:':
    'Không kết nối được Discord webhook:',
}
