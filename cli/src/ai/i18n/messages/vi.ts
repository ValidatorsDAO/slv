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
}
