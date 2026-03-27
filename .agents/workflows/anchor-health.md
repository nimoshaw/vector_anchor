---
description: Vector Anchor 服务健康检查
---

## 检查步骤

// turbo
1. 运行健康检查：
```powershell
Invoke-RestMethod -Uri http://localhost:23517/health -TimeoutSec 3
```

2. 根据结果输出状态：
   - 成功：显示 `✅ Vector Anchor 运行中 (版本: <version>, 运行时间: <uptime>s)`
   - 失败：显示 `⚠️ Vector Anchor 未运行。启动方式: cd d:\projects\vector_anchor && npm run serve`
