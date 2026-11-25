---
name: workbench-chain
description: 51 单片机效果落地链。当用户想要板子出现某种效果（流水灯/呼吸灯/串口报数/按键反应/数码管动画等）、要求编译烧写、或要看串口曲线时使用。按六步走完 产码→编译→烧写→点亮→验收→存档 整条链。
---

# 51 效果落地链（唯一权威流程）

开工先读 `docs/hardware-facts.md`（板卡参数、坑清单、API 速查）。服务没起就先运行根目录 `start-workbench.bat`（或 `py -m workbench.server --no-browser`）起在 `127.0.0.1:8765`。

## 六步契约

**0. 备料** — 读 `docs/hardware-facts.md`；调用 `GET /api/ports` 确认 CH340 串口在线。

**1. 产码** — 拷贝 `templates/mcu51/` → `experiments/NN-效果名/`（NN 接现有最大号 +1）；**只改 `main.c`**，`uart_put.h/c`、`STARTUP.A51` 与 `template51.uvproj` 不碰、不改名。

**2. 编译** — `POST /api/build {project}` → 轮询 `GET /api/job` 至 `status` 不再为 `running`。0 Error 才过；有错读 `diagnostics` 改 `main.c` 重编，**≤3 轮**，超出带错误原文问用户。`L16` warning 为良性（见 `docs/hardware-facts.md`）。

**3. 烧写** — `POST /api/serial/close` → `POST /api/flash {hex, port:第 0 步枚举出的 CH340 口, protocol:"stc89", wait:90}`（挂上即返回）→ **立刻**提示用户「90 秒内断电 3 秒再上电，可多试几次」→ 轮询 `GET /api/job` 至 `result.ok: true`。两轮窗口都未握上 → 存档"未烧成"收尾，不硬耗。串口号会漂移，严禁写死 `COM7`。

**4. 点亮显示** — 烧写完成后芯片自动开跑，无需二次断电 → `POST /api/serial/open {port:同一串口, baud:9600}` → 曲线面板开始画点、终端出现 `v: ...` 数据流。

**5. 验收** — 告知用户查看网页对应面板（曲线/终端）及板卡肉眼现象；**用户确认效果正确**才算通过；不对回第 1 步改 `main.c`。

**6. 存档** — 写 `experiments/NN-效果名/说明.md`：改动要点、编译日志摘要、曲线/页面验据截图、例外项单列成清单。

## 异常分支

- 串口被占：先 `POST /api/serial/close` 再 open。
- 编译 3 轮不过：停下问用户，附 C51 错误原文。
- hex 没生成：检查 Keil Output 页 `Create HEX File` 是否勾上。

## 红线

`templates/mcu51/`、`workbench/` 默认只读；波特率 `9600` 固定（改动需升级模板与硬件事实库）；服务仅绑 `127.0.0.1`；不引入第三方 Web 依赖。
