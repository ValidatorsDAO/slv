# Solana Testnet Update — Rollback & Restart

**Summary**  
This release coordinates a testnet rollback and restart. The commands below perform the same operations as the official runbook.

**Reference (official runbook):**  
https://github.com/anza-xyz/agave/wiki/2025-10-01-Testnet-rollback-and-restart

---

## Actions Required

### 1) Perform the automated update steps

Copy and paste each command as shown:

```
slv upgrade
```

```
slv v update:script
```

```
slv v update:version
```

---

### 2) If you are running Firedancer

Setup 

```
slv v setup:firedancer
```

### 3) Restart Node

```
slv v stop
slv v cleanup
slv v start
```

---

### 4) After the ledger finishes loading

Set your validator identity:

```
slv v set:identity
```

---

**That’s it.**
