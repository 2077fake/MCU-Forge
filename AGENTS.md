# AGENTS.md — MCU-Forge（芯铸 51）

MCU-Forge（芯铸 51）自驱动工作台：用户在对话中下达想要的效果 → Agent 按 `SKILL.md` 走完整链路（产码/编译/烧写/开串口）→ 用户在网页工作台上看结果。网页（`workbench/static/`）是**纯展示面板**，所有编译、烧写与串口作业均经本机 API（`127.0.0.1:8765`）发起。

## 红线（违反即停）

1. `templates/mcu51/` 与 `workbench/` 默认只读。日常实验的改动只落在 `experiments/NN-效果名/` 与文档中；修改模板或工作台本身需用户明确批准。
2. 烧写前必须先关串口（`POST /api/serial/close`），否则端口占用；烧写与串口监视互斥。
3. 不引入重型第三方 Web 依赖：后端只使用 Python 标准库 + 已安装的 `pyserial` / `stcgal`。

## 真相地图

- 板卡参数、引脚映射、踩坑事实库、API 速查 → `docs/hardware-facts.md`
- 效果落地六步流程（唯一权威）→ `SKILL.md`
- 只读骨架工程 → `templates/mcu51/`
- 工作台实验产物 → `experiments/NN-效果名/`（源码 + `说明.md` 同目录）
- 传统课程汇编实验归档 → `coursework/exp1-asm` ~ `exp3-asm`

## 纪律

- 验收标准 = 用户在网页或板卡上看得见（曲线动了、终端有字、LED/数码管现象正确）；"后台跑通了"不算数。
- 每轮实验的例外项单列成清单，便于溯源。
- 没把握的硬件事实标 `[推断]`，真机验证后转正；不编造文档没写的内容。

## 环境

- Windows 控制台默认 GBK：向 API 发中文 JSON 先落 UTF-8 文件再 `curl --data-binary "@文件"`；抓 Python 输出加 `PYTHONIOENCODING=utf-8`。
- 服务单实例，端口 `8765`；启动用仓库根目录 `start-workbench.bat` 或 `py -m workbench.server`。
- 所有路径均以本仓库根目录为准（相对路径）。
