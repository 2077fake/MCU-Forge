# MCU-Forge（芯铸 51）

面向 STC89/AT89C52 开发板（HC6800-ES / 普中 A2 兼容）的 AI 自驱动开发与实时遥测工作台：
**Agent 产码 → Keil UV4 编译 → stcgal ISP 烧写 → 串口日志与多通道曲线实时展示**。

## 目录结构

```text
.
├── AGENTS.md                  # AI 协作规范与工程红线
├── SKILL.md                   # 51 效果落地链（六步契约）
├── start-workbench.bat        # Windows 一键启动器（自动打开 http://127.0.0.1:8765）
├── docs/
│   └── hardware-facts.md      # 板卡参数、引脚映射、串口协议、踩坑库与 API 速查
├── templates/
│   └── mcu51/                 # 只读 51 骨架工程（含 uart_put 曲线打点库）
├── workbench/                 # 工作台核心包（零第三方 Web 依赖，仅用标准库 + pyserial/stcgal）
│   ├── core.py                # 纯逻辑层：日志诊断、HEX 校验、曲线解析、工程扫描
│   ├── toolchain.py           # Keil UV4 编译与 stcgal 烧写封装（Web 与 CLI 共用）
│   ├── serial_mgr.py          # 串口独占管理与实时推送
│   ├── server.py              # HTTP + SSE 后端服务
│   ├── cli.py                 # 命令行编译烧写工具
│   ├── static/                # 前端静态资源（index.html / app.css / app.js）
│   └── tests/                 # 离线单元测试
├── experiments/               # 工作台实验产物（01-折返跑马灯 ~ 04-数码管动画）
└── coursework/                # 传统课程汇编实验归档（exp1-asm ~ exp3-asm）
```

## 快速启动

1. **启动网页工作台**（仅监听 `127.0.0.1:8765`）：
   - 双击 `start-workbench.bat`，或命令行运行：
     ```powershell
     py -m workbench.server
     ```
2. **命令行编译 / 烧写**（无需打开网页时）：
   ```powershell
   py -m workbench.cli --build-only
   py -m workbench.cli experiments/01-折返跑马灯/template51.uvproj
   ```
3. **运行单元测试**：
   ```powershell
   py -m unittest discover -s workbench/tests -v
   ```
