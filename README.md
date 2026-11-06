# dsh-comfyui-supervisor

**Lazy start / idle-exit lifecycle tools for a local ComfyUI server — as a DeepSeek Harness (DSH) plugin.**

The plugin starts nothing at boot. It gives the agent three tools to manage ComfyUI on demand:

| Tool | What it does |
|---|---|
| `comfyui_status` | Is ComfyUI up? Which device? Is this instance managed by us? VRAM / version. |
| `comfyui_start` | Ensure ComfyUI is running: probe → spawn a detached supervisor → wait until ready. |
| `comfyui_stop` | Stop it and release RAM/VRAM. Only kills instances we started unless `force=true`. |

The bundled supervisor (`assets/supervise.cjs`, zero dependencies) keeps the process tree alive while
it is in use and kills it after N idle minutes — no more "leave ComfyUI running all day" or
"remember to start it before generating".

> Unofficial community tool. Not affiliated with ComfyUI, DeepSeek or AMD.

## The problem

Local image plugins for DSH (and for every other harness) assume one of two things:

- **ComfyUI is always on** → 3–4 GB of RAM plus a resident GPU allocation while you are not even
  generating, or
- **you start it by hand** → the first `generate_image` call fails, and you have to switch windows,
  remember the batch file, wait ~40–60 s, then retry.

Both are bad. This plugin makes the lifecycle explicit and automatic: start on demand, exit when idle.

## Install

```powershell
# recommended: GitHub tarball (no npm account, no SSH key required)
dsh plugin --profile web add https://github.com/nizhouding-tech/dsh-comfyui-supervisor/archive/refs/heads/main.tar.gz

# pinned to the v0.1.0 release
dsh plugin --profile web add https://github.com/nizhouding-tech/dsh-comfyui-supervisor/archive/refs/tags/v0.1.0.tar.gz
```

> `github:` shorthand (`dsh plugin add github:user/repo`) resolves to `git+ssh://` in pnpm and fails
> without SSH keys. Either use the tarball URLs above, or run `pnpm config set git-protocol https`
> first.

Restart DSH once. The three tools then appear in the tool table.

> Requires: DSH 0.2.x, Node 22+, Windows for the process-tree kill (the probe/start path is portable).

## Configure

`cordis.patch.yml` of the installed plugin entry:

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

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI endpoint used for probing |
| `comfyRoot` | `D:\ComfyUI` | Where `ComfyUI_windows_portable` and `logs/` live |
| `idleTimeoutMinutes` | `30` | Kill ComfyUI after this much time without generation |
| `startTimeoutSeconds` | `300` | How long `comfyui_start` waits for readiness |

## How it works

```
comfyui_start
   ├─ GET /system_stats  → up?  return immediately
   └─ spawn(node assets/supervise.cjs --root ... --port ... --idle-min ...)
          ├─ writes .supervisor.lock (single instance) + .supervisor.state (pids)
          ├─ starts ComfyUI, waits for /system_stats
          ├─ polls /queue and /history every 15 s
          └─ idle > idleTimeoutMinutes → taskkill /T /F, remove state files, exit
```

`comfyui_status` reads the state file to tell you **whether the running instance is managed**, and
`comfyui_stop` refuses to kill an instance it did not start unless you pass `force: true`.

The plugin itself performs **no network request and no process spawn at load time** — DSH cold start
is completely unaffected.

## Verified behaviour

Measured on Windows 11, Ryzen AI MAX+ 395 / Radeon 8060S, ComfyUI 0.44.0:

| Action | Result |
|---|---|
| `comfyui_start` from cold | ready in **~10 s**, device `AMD Radeon(TM) 8060S Graphics` |
| `comfyui_status` while running | reports device, free VRAM (~101 GB), ComfyUI version, `managed=true` |
| `comfyui_stop` | Python tree killed, VRAM released, `running=false` |
| idle timeout (tested with `--idle-min 1`) | killed at exactly 1 minute, lock/state cleaned |
| `comfyui_stop` when nothing runs | no-op, `changed=false` |
| All three tools through the real DSH tool interface | `status → start → status → stop` returned the expected values, no restart needed after install |

## Limitations / roadmap

- Process-tree kill uses `taskkill` (Windows). Linux/macOS branch is a TODO.
- Releasing a "service" other plugins can inject (so a single plugin manages lifecycle) is planned.
- npm publication pending; GitHub install works today.

## License

MIT © 2026 Zhouding Jeff Ni ([@nizhouding-tech](https://github.com/nizhouding-tech))

## Contact

- Email: **nizhouding@gmail.com** / **1005245828@qq.com**
- GitHub: [@nizhouding-tech](https://github.com/nizhouding-tech)
