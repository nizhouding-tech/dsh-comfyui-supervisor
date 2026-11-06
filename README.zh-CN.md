# dsh-comfyui-supervisor

**给本地 ComfyUI 加「懒启动 / 空闲退出」生命周期的 DSH 插件。**

插件启动时什么都不做，只给 Agent 三个工具：

| 工具 | 作用 |
|---|---|
| `comfyui_status` | ComfyUI 在不在跑、什么设备、显存/版本、是不是本插件托管的实例 |
| `comfyui_start` | 确保在跑：探活 → 拉起后台守护 → 等到就绪 |
| `comfyui_stop` | 停掉并释放内存/显存；默认只停自己启动的实例，手动启动的需 `force=true` |

随包带一个零依赖守护进程（`assets/supervise.cjs`）：用的时候保持存活，**空闲 N 分钟后自动杀掉整棵进程树**。不用再「整天开着 ComfyUI」，也不用「生图前先手动双击 bat」。

> 社区工具，与 ComfyUI / DeepSeek / AMD 官方无关。

## 解决什么问题

本地生图插件（不限 DSH）通常假设两件事之一：

- **ComfyUI 一直开着** → 不生成的时候也占 3–4GB 内存和常驻显存；
- **生图前手动启动** → 第一次 `generate_image` 直接失败，得切窗口、找 bat、等 40–60 秒再重试。

这个插件把生命周期变成显式、自动的：按需启动、空闲退出。

## 安装

```powershell
# 推荐：GitHub tarball（不需要 npm 账号，也不需要 SSH key）
dsh plugin --profile web add https://github.com/nizhouding-tech/dsh-comfyui-supervisor/archive/refs/heads/main.tar.gz

# 固定到 v0.1.0 发布版
dsh plugin --profile web add https://github.com/nizhouding-tech/dsh-comfyui-supervisor/archive/refs/tags/v0.1.0.tar.gz
```

> pnpm 的 `github:` 简写会解析成 `git+ssh://`，本机没有 SSH key 时必然失败。用上面的 tarball 链接，
> 或者先执行 `pnpm config set git-protocol https`。

安装后重启一次 DSH，三个工具就会出现在工具表里。

> 依赖：DSH 0.2.x、Node 22+、Windows（进程树清理用 taskkill；探测/启动路径本身跨平台）。

## 配置

已安装插件 entry 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: comfyui-supervisor
      name: dsh-comfyui-supervisor
      config:
        baseUrl: http://127.0.0.1:8188
        comfyRoot: D:\ComfyUI
        idleTimeoutMinutes: 30
        startTimeoutSeconds: 300
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8188` | 探活用的 ComfyUI 地址 |
| `comfyRoot` | `D:\ComfyUI` | `ComfyUI_windows_portable` 与 `logs/` 所在目录 |
| `idleTimeoutMinutes` | `30` | 多久没有生成活动就退出 |
| `startTimeoutSeconds` | `300` | `comfyui_start` 等待就绪的上限 |

## 工作原理

```
comfyui_start
   ├─ GET /system_stats  → 在跑？直接返回
   └─ spawn(node assets/supervise.cjs --root ... --port ... --idle-min ...)
          ├─ 写 .supervisor.lock（单实例）与 .supervisor.state（pid）
          ├─ 启动 ComfyUI，等 /system_stats 就绪
          ├─ 每 15 秒看 /queue 与 /history
          └─ 空闲超过 idleTimeoutMinutes → taskkill /T /F、清理状态文件、退出
```

`comfyui_status` 读状态文件告诉你「这个实例是不是托管的」；`comfyui_stop` 默认**不会**杀掉不是它启动的实例，需要你显式 `force: true`。

插件加载阶段**不发网络请求、不启动进程**，对 DSH 冷启动零影响。

## 实测

Windows 11、Ryzen AI MAX+ 395 / Radeon 8060S、ComfyUI 0.44.0：

| 操作 | 结果 |
|---|---|
| 冷启动 `comfyui_start` | 约 **10 秒**就绪，设备 `AMD Radeon(TM) 8060S Graphics` |
| 运行中 `comfyui_status` | 设备、空闲显存（约 101GB）、ComfyUI 版本、`managed=true` |
| `comfyui_stop` | Python 进程树被杀、显存释放、`running=false` |
| 空闲退出（用 `--idle-min 1` 实测） | 第 1 分钟准时退出，锁与状态文件清理 |
| 没在跑时 `comfyui_stop` | 无操作，`changed=false` |
| 三个工具走真实 DSH 工具接口 | `status → start → status → stop` 全部返回预期值，安装后无需重启即可加载 |

## 限制 / 路线图

- 进程树清理用 `taskkill`（Windows）；Linux/macOS 分支待补。
- 计划把生命周期注册成可在插件间注入的 service（由它统一管理）。
- npm 发布待办；现在用 GitHub 安装可用。

## 许可

MIT © 2026 Zhouding Jeff Ni ([@nizhouding-tech](https://github.com/nizhouding-tech))

## 联系

- 邮箱：**nizhouding@gmail.com** / **1005245828@qq.com**
- GitHub：[@nizhouding-tech](https://github.com/nizhouding-tech)
