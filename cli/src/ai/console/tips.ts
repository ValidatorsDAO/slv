/**
 * Loading tips shown while specialist agents are working.
 * Tips rotate every few seconds, giving users useful Solana knowledge
 * while they wait — turning wait time into learning time.
 */

export const GENERAL_TIPS: string[] = [
  // Latency & Performance
  '💡 Lower latency = better trades. Co-locate your bot with the validator for sub-millisecond execution.',
  '💡 Solana leaders rotate every 4 slots (~1.6 seconds). Sending transactions during YOUR leader slot = fastest confirmation.',
  '💡 gRPC streaming is 10-100x faster than polling RPC for real-time data. Perfect for trading bots.',
  "💡 ShredStream delivers raw block data before it's even confirmed — the fastest way to see new transactions.",
  '💡 Staked connections (SWQoS) get priority transaction scheduling. Essential for competitive trading.',
  '💡 Tip: Use dedicated RPC for sends, shared RPC for reads. Optimize where it matters most.',

  // Validator tips
  '💡 A well-tuned validator can achieve 0 skip rate. CPU frequency and NVMe speed are the biggest factors.',
  '💡 Validators earn SOL from block rewards + priority fees. Higher stake = more leader slots = more revenue.',
  '💡 Jito validators earn additional MEV tips. Most mainnet validators run Jito for the extra revenue.',
  '💡 AMD EPYC and Ryzen CPUs with high single-thread boost clocks perform best for Solana validators.',
  '💡 NVMe drives handle millions of account reads per second. RAID0 across multiple drives maximizes throughput.',
  '💡 Solana validators need 384GB+ RAM for mainnet. Testnet works fine with 32-128GB.',

  // Trading & Bot tips
  '💡 The fastest traders use gRPC + ShredStream together — gRPC for account updates, ShredStream for new transactions.',
  '💡 Jito bundles let you group transactions atomically. No more partial fills or sandwich attacks.',
  '💡 Tip: Run your trading bot on the same network as your gRPC node. Internal traffic has zero latency.',
  '💡 Solana processes ~65,000 TPS. Your bot competes with thousands of others — speed is everything.',
  '💡 Want 0-slot trading? Place your bot server in the same datacenter as the current leader validator.',

  // Infrastructure tips
  '💡 All ERPC services in the same datacenter share a private network — zero bandwidth costs between them.',
  '💡 Server provisioning takes ~30 minutes. Your login credentials will be emailed automatically.',
  '💡 SLV automates the entire deployment — from OS setup to Solana binary builds. No manual config needed.',
  '💡 Pro tip: Keep your validator identity key backed up securely. Losing it means losing your stake.',
  '💡 Solana releases new versions frequently. SLV tracks them and notifies you when updates are available.',

  // Network & Architecture
  '💡 Solana uses Gulf Stream — transactions are forwarded to the next leader before the current slot ends.',
  '💡 Turbine breaks blocks into "shreds" and distributes them across the network like a torrent.',
  "💡 Solana's Proof of History (PoH) creates a verifiable passage of time — no waiting for consensus on ordering.",
  '💡 The Solana cluster has ~1,500 validators globally. More geographic diversity = stronger network.',
]

export const FIGARO_TIPS: string[] = [
  '🛒 Bare metal servers provide dedicated resources — no noisy neighbors affecting your performance.',
  '🛒 ERPC servers are pre-optimized for Solana: NVMe RAID, high-frequency CPUs, 10Gbps networking.',
  '🛒 Same-region servers communicate over private networks — perfect for validator + RPC combos.',
  '🛒 Testnet is great for practice. Start with APP tier, then upgrade to MV for mainnet.',
  '🛒 Pro tip: Choose a region close to the majority of Solana validators for lower skip rates.',
  '🛒 All servers include automatic OS setup, security hardening, and Solana-optimized configs.',
  '🛒 Amsterdam and Frankfurt have the most ERPC infrastructure — lowest latency to other services.',
]

export const CECIL_TIPS: string[] = [
  '⚔️ Validators earn more during high-traffic periods. Priority fees spike during NFT mints and token launches.',
  '⚔️ Identity migration (hot-swap) lets you upgrade hardware with zero downtime for your stake.',
  "⚔️ Firedancer is Solana's new validator client — built for maximum performance from the ground up.",
  '⚔️ Jito tips go directly to your validator. Top validators earn 100+ SOL/day in MEV tips.',
  '⚔️ Testnet validators help you learn operations risk-free before committing real SOL on mainnet.',
]

export const TINA_TIPS: string[] = [
  '🔧 Index RPC stores the full transaction history — essential for block explorers and analytics.',
  '🔧 gRPC Geyser streams account changes in real-time. Way faster than polling getAccountInfo.',
  '🔧 Combining Index RPC + gRPC on one node gives you the best of both worlds.',
  '🔧 Yellowstone gRPC can filter by program, account, or transaction type — only get what you need.',
]

export const CID_TIPS: string[] = [
  '📡 Run grpc_test first for quick reachability and latency, then use geyserbench when you need throughput numbers.',
  '📡 Test from the same region as your app or bot. Cross-region benchmarks hide the real bottleneck.',
  '📡 If gRPC is reachable but slow, compare TLS handshake time, stream startup time, and sustained message rate separately.',
  '📡 ShredStream checks are best done alongside gRPC checks — both matter when you care about earliest possible signal.',
]

export const SETZER_TIPS: string[] = [
  "🎰 Solana's 400ms block time makes it the fastest chain for on-chain trading.",
  '🎰 Jupiter aggregates all Solana DEX liquidity. One API call for the best swap route.',
  '🎰 Raydium CLMM pools offer concentrated liquidity — higher capital efficiency for market makers.',
  '🎰 Tip: Use websocket subscriptions to react to price changes instantly, not HTTP polling.',
]

/**
 * Get tips for a specific agent, with general tips mixed in.
 */
export function getTipsForAgent(agentName: string): string[] {
  const agentTips: Record<string, string[]> = {
    'Figaro': FIGARO_TIPS,
    'Cecil': CECIL_TIPS,
    'Tina': TINA_TIPS,
    'Cid': CID_TIPS,
    'Setzer': SETZER_TIPS,
  }
  const specific = agentTips[agentName] || []
  // Mix: 60% agent-specific, 40% general
  return [...specific, ...GENERAL_TIPS]
}

/**
 * Pick a random tip, avoiding repeats.
 */
let lastTipIndex = -1
export function pickRandomTip(tips: string[]): string {
  if (tips.length === 0) return ''
  if (tips.length === 1) return tips[0]
  let index: number
  do {
    index = Math.floor(Math.random() * tips.length)
  } while (index === lastTipIndex)
  lastTipIndex = index
  return tips[index]
}
