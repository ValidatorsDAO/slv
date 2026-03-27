# Skill: slv-server-procurement

Server procurement and provisioning management for SLV users.

## Overview
Figaro finds the perfect server for the user's needs, presents it attractively, and provides a purchase link.

## Primary MCP Tools (use these first)

### 1. Search Available VPS
```
call_mcp(tool_name="get_vps_search_available_vps", arguments={region: "eu", spec: "..."})
```
Find available VPS instances by region and spec.

### 2. Check BareMetal Availability
```
call_mcp(tool_name="get_baremetal_availability")
```
Check unassigned BareMetal subscriptions the user already has.

### 3. Generate Payment Link
```
call_mcp(tool_name="post_billing_generate_payment_link", arguments={items: [{price: "<priceId>", quantity: 1}], region: "amsterdam"})
```
Generate a Stripe payment link for the user to purchase.
Get priceId from the product list first.

## Secondary MCP Tools

### Server Product Lists
- `call_mcp(tool_name="get_baremetal_server_list_server_type", arguments={serverType: "<TYPE>"})` — List products by type

### Server Types
| serverType | Use Case |
|------------|----------|
| `APP`      | Testnet validators, dev/test, apps |
| `MV`       | Mainnet validators |
| `MV+`      | Mainnet validators (premium) |
| `MV++`     | Mainnet validators (top-tier) |
| `RPC`      | RPC nodes (Index RPC, gRPC Geyser, combos) |

### Status Tracking
- `call_mcp(tool_name="get_baremetal_status")` — Check user's assigned servers
- `call_mcp(tool_name="get_vps_status")` — Check user's VPS status
- `call_mcp(tool_name="get_vps_list")` — List VPS plans

## Mapping: User request -> serverType
- "testnet validator" -> APP (128GB+ RAM minimum)
- "mainnet validator" -> MV or MV+
- "RPC node" / "gRPC node" -> RPC
- "dev server" / "app server" -> APP

## Minimum specs for Solana nodes
- Testnet validator: 128GB RAM minimum
- Mainnet validator: 384GB RAM minimum
- gRPC Geyser only: 384GB RAM minimum
- Index RPC (without gRPC): 768GB RAM minimum
- Index RPC + gRPC: 1TB RAM minimum

## Procurement Flow
1. Determine serverType from user request
2. Check availability first (get_baremetal_availability / get_vps_search_available_vps)
3. If user has unassigned subscriptions, recommend using those
4. Otherwise, get product list and recommend ONE product
5. Generate payment link when user is ready
6. Present with full URL on its own line for easy copy-paste

## CRITICAL Rules
1. NEVER modify payment links. Output exactly as-is from API.
2. Show URL on its own line, NOT inside markdown link syntax.
3. Recommend ONE product. Show alternatives only if asked.
4. Use correct serverType mapping.
5. Do NOT run shell commands. MCP only.

## Regions
amsterdam, frankfurt, ny, tokyo, london, singapore, sydney
