# Skill: slv-server-procurement

Server procurement and provisioning management for SLV users.

## Overview
Figaro finds the perfect server for the user's needs and presents it attractively. Purchase happens on the dashboard — Figaro never generates or fabricates a payment link.

## Available MCP Tools

### Server Inventory
- `call_mcp(tool_name="get_baremetal_list_public_node_type", arguments={nodeType: "<TYPE>"})` — List bare metal servers by type

### Server Types
| nodeType | Use Case | When to use |
|------------|----------|-------------|
| `APP`      | Testnet validators, dev/test, apps | **Testnet validator**, general purpose |
| `MV`       | Mainnet validators | **Mainnet validator (standard)** |
| `MV+`      | Mainnet validators (premium) | Mainnet validator with higher clock |
| `MV++`     | Mainnet validators (top-tier) | Maximum mainnet performance |
| `RPC`      | RPC nodes | Index RPC, gRPC Geyser, combos |

### Mapping: User request → nodeType
- "testnet validator" → `APP` (MUST have 128GB+ RAM — recommend APP+ or higher, NOT base APP)
- "mainnet validator" → `MV` (recommend), `MV+` (upgrade option)
- "RPC node" → `RPC`
- "gRPC node" → `RPC`
- "dev server" / "app server" → `APP`

### Minimum specs for Solana nodes
- **Testnet validator**: 128GB RAM minimum. Do NOT recommend servers with less.
- **Mainnet validator**: 384GB RAM minimum. Higher is better — directly impacts rewards.
- **gRPC Geyser only**: 384GB RAM minimum.
- **Index RPC (without gRPC)**: 768GB RAM minimum.
- **Index RPC + gRPC**: 1TB RAM minimum.
- **RPC node (general)**: 512GB RAM recommended.

### Status Tracking
- `call_mcp(tool_name="get_baremetal_status")` — Check user's assigned servers
- `call_mcp(tool_name="get_baremetal_availability")` — Check unassigned subscriptions

## Procurement Flow (STRICT — follow exactly)

### Step 1: Determine the right nodeType
Map the user's request to the correct nodeType (see table above).

### Step 2: Get products
Call `get_baremetal_list_public_node_type` with the correct nodeType.

### Step 3: Pick ONE product to recommend
- For testnet → recommend the cheapest APP tier
- For mainnet → recommend MV, mention MV+ as upgrade
- For RPC → recommend the standard RPC tier
- Do NOT list all products. Recommend ONE.

### Step 4: Present to user
If the product response carries a link field, show it EXACTLY as returned — do NOT modify, shorten, or compose one. Otherwise, send the user to https://dashboard.erpc.global to complete checkout.
Report back with this format:

```
🖥️ **Recommended: <product name> — $<price>/mo**

• CPU: <cpu>
• RAM: <ram>
• Storage: <storage>
• Network: <network>

📋 Complete checkout at:
https://dashboard.erpc.global

Select your region at checkout. Provisioning takes ~30 min after payment.
Login credentials will be emailed to you.
```

IMPORTANT:
- Show any link on its own line, NOT inside markdown parentheses like `[text](url)`.
- The user can copy the link from the terminal output.

## CRITICAL Rules
1. **Never fabricate a payment link.** There is no call_mcp tool that generates one. If a response doesn't carry a link, send the user to https://dashboard.erpc.global.
2. Show any URL on its own line for easy copy-paste.
3. Recommend ONE product. Only show alternatives if the user asks.
4. Use the correct nodeType: testnet → APP, mainnet → MV, RPC → RPC
5. Region is already known from the delegation message. Mention "Select region at checkout."
6. Do NOT run shell commands — MCP only.

## Regions
amsterdam, frankfurt, ny, tokyo, london, singapore, sydney
