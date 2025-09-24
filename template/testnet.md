# 🚀 Release: Solana Testnet Validator — Maintenance/Upgrade Notes

This release focuses on keeping your  testnet validators up-to-date with the latest `slv` tooling and `agave-validator` setup. Follow the steps below to upgrade safely and apply changes.

---

## ✅ Highlights
- Upgrade `slv` to the latest version  
- Update validator version config  
- Refresh/update `agave-validator`
- Clean restart sequence for applying changes  
- Guidance for identity switch (no-downtime) or hot-spare assignment  

---

## 🧰 Upgrade Steps

For Agave Testnet Validator

### 1) Upgrade `slv`
```
slv upgrade
```

### 2) Update version config
```
slv v update:version -c
┌─ Mainnet Validators ───────────────────────┐
  Agave: 2.3.8 = 2.3.8
  Jito: 2.3.8 = 2.3.8
  Firedancer: 0.708.20306 → 0.709.30000

┌─ Testnet Validators ───────────────────────┐
  Agave: 3.0.0 → 3.0.1
  Firedancer: 0.708.20306 = 0.708.20306

┌─ Mainnet RPCs ────────────────────────────┐
  Agave: 2.3.8 = 2.3.8
  Jito: 2.3.8 = 2.3.8
  Firedancer: 0.708.20306 → 0.709.30000
  Geyser: v9.0.0+solana.2.3.8 = v9.0.0+solana.2.3.8
```

### 3) Update/Setup `agave-validator`
```
slv v update:version -n testnet
```

For Frankendancer Testnet Validator
```
slv setup:firedancer -n testnet
```

### 4) Restart Validator to apply changes
```
slv v stop  -n testnet
slv v start  -n testnet
```
### 5) Identity Switch

After ledger catch-up is complete, switch identity using one of the following commands:

```
slv v set:identity -n testnet
```

> ℹ️ Ensure your identity address, vote address must be correctly set in your `~/.slv/inventory.testnet.validators.yml` file before running these commands.

---

## 📝 Notes
- After restart, verify health (slots, leader schedule, and network connectivity) and monitor logs.  

---