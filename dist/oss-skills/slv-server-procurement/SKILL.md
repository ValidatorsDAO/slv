# Skill: slv-server-procurement

Server procurement and provisioning management for SLV users.

## Overview
Figaro finds the perfect server for the user's needs, presents it attractively, and provides a purchase link.

## Available MCP Tools

### Server Inventory
- `call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "<TYPE>"})` — List bare metal servers by type

### Server Types
| serverType | Use Case | When to use |
|------------|----------|-------------|
| `APP`      | Testnet validators, dev/test, apps | **Testnet validator**, general purpose |
| `MV`       | Mainnet validators | **Mainnet validator (standard)** |
| `MV+`      | Mainnet validators (premium) | Mainnet validator with higher clock |
| `MV++`     | Mainnet validators (top-tier) | Maximum mainnet performance |
| `RPC`      | RPC nodes | Index RPC, gRPC Geyser, combos |

### Mapping: User request → serverType
- "testnet validator" → `APP` (MUST have 128GB+ RAM — recommend APP+ or higher, NOT base APP)
- "mainnet validator" → `MV` (recommend), `MV+` (upgrade option)
- "RPC node" → `RPC`
- "gRPC node" → `RPC`
- "dev server" / "app server" → `APP`

### Minimum specs for Solana nodes
- **Testnet validator**: 128GB RAM minimum. Do NOT recommend servers with less.
- **Mainnet validator**: 384GB RAM minimum.
- **RPC node**: 512GB RAM recommended.

### Status Tracking
- `call_mcp(tool_name="get_baremetal_status")` — Check user's assigned servers
- `call_mcp(tool_name="get_baremetal_availability")` — Check unassigned subscriptions

## Procurement Flow (STRICT — follow exactly)

### Step 1: Determine the right serverType
Map the user's request to the correct serverType (see table above).

### Step 2: Get products
Call `get_baremetal_server_list_server_type` with the correct serverType.

### Step 3: Pick ONE product to recommend
- For testnet → recommend the cheapest APP tier
- For mainnet → recommend MV, mention MV+ as upgrade
- For RPC → recommend the standard RPC tier
- Do NOT list all products. Recommend ONE.

### Step 4: Present to user
Use the paymentLink EXACTLY as returned from the API. Do NOT modify, shorten, or remove any part of the URL. The full URL including the # fragment is REQUIRED for checkout to work.
Report back with this EXACT format:

```
🖥️ **Recommended: <product name> — $<price>/mo**

• CPU: <cpu>
• RAM: <ram>
• Storage: <storage>
• Network: <network>

📋 Purchase here:
<paymentLink_url>

Select your region at checkout. Provisioning takes ~30 min after payment.
Login credentials will be emailed to you.
```

IMPORTANT:
- Show the URL on its own line, NOT inside markdown parentheses like `[text](url)`.
- The user can copy the link from the terminal output.

## CRITICAL Rules
1. **NEVER modify payment links.** Output the paymentLink from the API response EXACTLY as-is. Do NOT strip, truncate, shorten, or remove any characters including the # fragment. Broken links = lost sales.
2. Show the URL on its own line for easy copy-paste.
3. Recommend ONE product. Only show alternatives if the user asks.
4. Use the correct serverType: testnet → APP, mainnet → MV, RPC → RPC
5. Region is already known from the delegation message. Mention "Select region at checkout."
6. Do NOT run shell commands — MCP only.

## Regions
amsterdam, frankfurt, ny, tokyo, london, singapore, sydney
