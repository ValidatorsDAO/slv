# Skill: slv-server-procurement

Server procurement and provisioning management for SLV users.

## Overview
Figaro handles all server acquisition tasks — from browsing available servers to generating payment links and tracking provisioning.

## Available MCP Tools

### Server Inventory
- `call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "MV"})` — List validator-grade bare metal servers (MV = Metal Validator)
- `call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "MR"})` — List RPC-grade bare metal servers (MR = Metal RPC)
- `call_mcp(tool_name="get_vps_list")` — List VPS plans
- `call_mcp(tool_name="get_vps_search_available_vps", arguments={region: "<region>", spec: "<spec>"})` — Search available VPS by region/spec

### Server Types
| Type | Use Case | Typical Specs |
|------|----------|---------------|
| MV   | Solana Validators | High single-thread CPU, 384GB+ RAM, NVMe |
| MV+  | Solana Validators (Premium) | Higher clock speed |
| MV++ | Solana Validators (Top-tier) | Highest clock speed, more cores |
| MR   | Solana RPC Nodes | High core count, large storage |

### Payment Links
- `call_mcp(tool_name="post_billing_generate_payment_link", arguments={items: [{price: "<priceId>", quantity: 1}], region: "<region>"})` — Generate Stripe payment link
  - `priceId` comes from the product list response (`paymentLink` or `priceId` field)
  - `region`: amsterdam, frankfurt, ny, tokyo, london, singapore, sydney

### Status Tracking
- `call_mcp(tool_name="get_baremetal_status")` — Check user's BareMetal status (assigned servers)
- `call_mcp(tool_name="get_baremetal_availability")` — Check unassigned subscriptions
- `call_mcp(tool_name="get_vps_status")` — Check user's VPS status

## Procurement Flow

### When user needs a validator server:
1. Call `get_baremetal_server_list_server_type` with `serverType: "MV"`
2. Present options with specs and monthly pricing
3. If the product response includes a `paymentLink` field, show that directly
4. If no `paymentLink`, generate one via `post_billing_generate_payment_link`
5. Tell the user: provisioning takes ~30 minutes after payment
6. They can check status later or come back when ready

### When user needs an RPC server:
1. Call `get_baremetal_server_list_server_type` with `serverType: "MR"`
2. Same flow as above

### When user wants VPS instead:
1. Call `get_vps_list` to show plans
2. Call `get_vps_search_available_vps` with region preference
3. Generate payment link if needed

## Response Format
When reporting back to the main agent:
- List available servers as bullet points with:
  - **Name** — CPU, Cores, RAM, Storage, Bandwidth
  - **Price** — monthly cost
  - **Link** — payment/purchase URL
- Always include the region in the response
- If nothing is available, say so clearly and suggest checking back later

## Regions
Available regions: amsterdam, frankfurt, ny, tokyo, london, singapore, sydney

## Important Notes
- The `paymentLink` in product responses is a pre-built Stripe checkout URL — use it directly when available
- After purchase, Stripe webhook automatically assigns and builds the server
- Login credentials are sent to the user's email after provisioning
- Do NOT run shell commands for procurement — everything goes through MCP
