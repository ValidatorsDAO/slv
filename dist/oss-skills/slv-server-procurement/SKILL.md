# Skill: slv-server-procurement

Server procurement and provisioning management for SLV users.

## Overview
Figaro handles all server acquisition tasks — recommending the right server, generating a clean payment link, and tracking provisioning.

## Available MCP Tools

### Server Inventory
- `call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "MV"})` — List validator-grade bare metal servers
- `call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "MR"})` — List RPC-grade bare metal servers
- `call_mcp(tool_name="get_vps_list")` — List VPS plans
- `call_mcp(tool_name="get_vps_search_available_vps", arguments={region: "<region>", spec: "<spec>"})` — Search available VPS

### Payment Link Generation
- `call_mcp(tool_name="post_billing_generate_payment_link", arguments={items: [{price: "<priceId>", quantity: 1}], region: "<region>"})` — Generate a clean, short Stripe payment link
  - `priceId` comes from the product list response (look for `priceId` field in each product)
  - `region`: amsterdam, frankfurt, ny, tokyo, london, singapore, sydney

### Status Tracking
- `call_mcp(tool_name="get_baremetal_status")` — Check user's BareMetal status
- `call_mcp(tool_name="get_baremetal_availability")` — Check unassigned subscriptions
- `call_mcp(tool_name="get_vps_status")` — Check user's VPS status

## Server Types & Recommendations

### Validator Servers (serverType: "MV")
| Type | Use Case | Recommendation |
|------|----------|----------------|
| MV   | Testnet validators, budget mainnet | **Recommend for testnet** |
| MV+  | Mainnet validators, good balance | **Recommend for mainnet** |
| MV++ | Top-tier mainnet, maximum performance | Only if user wants the best |

### RPC Servers (serverType: "MR")
| Type | Use Case |
|------|----------|
| MR   | Index RPC, gRPC Geyser, combo setups |

## Procurement Flow (CRITICAL — follow this exactly)

### Step 1: Get product list
Call `get_baremetal_server_list_server_type` with the appropriate serverType (MV for validators, MR for RPC).

### Step 2: Pick the RIGHT product for the user
- **Testnet validator** → recommend MV (cheapest, more than enough)
- **Mainnet validator** → recommend MV+ (best value), mention MV++ as premium option
- **RPC node** → recommend MR
- Do NOT dump all products. Pick 1 recommendation (optionally mention 1 upgrade).

### Step 3: Generate a payment link
Use `post_billing_generate_payment_link` with:
- `items`: `[{price: "<priceId from the product>", quantity: 1}]`
- `region`: the user's preferred region (e.g. "amsterdam")

This returns a clean, short URL like `https://pay.erpc.global/c/pay/cs_live_...`

### Step 4: Present to user
Report back to the main agent with:
- The recommended server specs (CPU, RAM, Storage, Network)
- Monthly price
- A SHORT payment link: `[Purchase here](url)` — use the URL from generate-payment-link, NOT the raw paymentLink from the product list
- Note: "Provisioning takes ~30 minutes after payment. Login credentials will be emailed to you."

## Response Format (STRICT)
```
**Recommended: MV — $798/mo**
- AMD EPYC 9254 (4.15GHz, 24 Cores)
- 384GB ECC DDR5 RAM
- 1TB + 4TB x2 NVMe SSD
- 10Gbps, 200TB/mo bandwidth

[Purchase here](https://pay.erpc.global/c/pay/cs_live_xxx)

Provisioning takes ~30 min after payment. Login credentials will be emailed.
```

If user wants to see other options, THEN show alternatives. But default to ONE recommendation.

## IMPORTANT Rules
- ALWAYS use `post_billing_generate_payment_link` to create the link. Do NOT use the raw `paymentLink` field from the product list (those are long and ugly).
- ALWAYS wrap the link in markdown: `[Purchase here](url)`
- Do NOT show multiple products unless the user asks. Recommend ONE based on their use case.
- Do NOT run shell commands — everything goes through MCP.
- Region is already known from the main agent's delegation message.

## Regions
amsterdam, frankfurt, ny, tokyo, london, singapore, sydney
