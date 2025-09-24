# 🚀 Release: Solana Mainnet Validator for Firedancer — Maintenance/Upgrade Notes

This release focuses on keeping your Firedancer-based mainnet validators up-to-date with the latest `slv` tooling and `fdctl` setup. Follow the steps below to upgrade safely and apply changes.

---

## ✅ Highlights
- Upgrade `slv` to the latest version  
- Update validator version config  
- Refresh/update `fdctl` for Firedancer  
- Clean restart sequence for applying changes  
- Guidance for identity switch (no-downtime) or hot-spare assignment  

---

## 🧰 Upgrade Steps

### 1) Upgrade `slv`
```
slv upgrade
```

### 2) Update version config
```
slv v update:version -c
```

### 3) Update/Setup `fdctl` for Firedancer (mainnet)
```
slv setup:firedancer -n mainnet -p <name>
```

### 4) Restart Firedancer to apply changes
```
slv v stop  -n mainnet -p <name>
slv v start -n mainnet -p <name>
```

---

## 🆔 Identity Settings

You can set identity in two ways:

- **No-downtime migration (recommended):**
  ```
  slv v switch
  ```
  Switches identity/live traffic with near-zero downtime.

- **Set identity to a hot spare:**
  ```
  slv v set:identity
  ```
  Assigns the identity to your standby node.

> ℹ️ Ensure your identity address, vote address must be correctly set in your `~/.slv/inventory.mainnet.validators.yml` file before running these commands.

---

## 📝 Notes
- `-n mainnet` targets the mainnet profile; adjust if you maintain separate environments.  
- Replace `<name>` with your validator profile/instance name used in your `slv` setup.  
- After restart, verify health (slots, leader schedule, and network connectivity) and monitor logs.  
- If you use systemd or supervisors, confirm units are healthy post-restart.  

---