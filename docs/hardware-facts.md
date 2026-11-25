# 硬件与工作台事实库

维护规则：新坑随发现追加，每条带 `[日期/来源]`；`[推断]` 条目必须真机验证后才能转正并去掉标记。

## 板卡与器件

- 板子：HC6800-ES / 普中 A2 兼容 51 开发板 `[实测]`
- Keil 编译目标选 `AT89C52`；`stcgal` 烧写协议 `-P stc89` `[实测]`
- 实物芯片：`STC89C516RD+`（stcgal 握手上报，BSL 4.3C），实测频率 `10.989 MHz` `[2026-10-23 实测]`；与 Keil 目标 `AT89C52` 兼容
- 标称晶振：`11.0592 MHz`

## 串口与曲线协议

- 串口参数：`9600-8N1`；`UART_RELOAD = 0xFD`（在 `templates/mcu51/uart_put.c` 中，属模板红线）
- 曲线协议：固件周期性输出 `v: <值>[,<值>…]\r\n`，一行 = 一次采样，逗号分隔的每个数值各绘制一条通道曲线；单值即单通道 `[2026-10-23 实验02 实测确认]`
- 串口号会漂移：默认常见 `COM7`（CH340），但换 USB 口或重插后 Windows 会重新编号（实测曾变 `COM10`）。每次烧写/开串口前必须通过 `GET /api/ports` 现查 CH340 口，不可写死端口号

## 引脚与现象

- LED：接在 `P2`（共 8 位）。`[推断：低电平点亮，依据模板 LED = ~(...) 取反写法]`
- 数码管：8 位动态扫描；段码 = `P0`（经 74HC245，共阴编码，1=亮）；位选 = 74HC138，`A/B/C = P2.2/P2.3/P2.4`，`Y_i` 低有效选第 `i` 位，`Y0` = 左起第一位（无镜像）；前导零消隐 + 切位前清段码可消除鬼影。扫描时 LED 位 2–4 随位选闪动（与 P2 共脚）属正常现象 `[2026-10-24 实验04 真机验收通过]`

## 踩坑清单

- `[实测]` **STC89 只认冷启动**：烧写 = 断 VCC 3 秒再上电；DTR/RST 自动复位无效。`/api/flash` 内部是重试循环（默认 90s 窗口），先挂上 job 再断电即可。
- `[实测 2026-10-23]` **烧写完成自动开跑**：stcgal 输出 `Disconnected!` 后芯片自动启动新程序，**无需二次冷启动**；若个别次未跑，先按复位键或重上电排查。
- `[实测]` **串口互斥**：烧写前必须 `POST /api/serial/close`（后端也会自动释放）；串口监视与烧写互斥。
- `[实测]` **良性 L16 警告**：编译日志常出现 `L16 (?PR?_UART_CURVE?UART_PUT uncalled)`——因模板中单参 `uart_curve` 未调用，属良性警告，无需处理。
- `[实测]` **Windows 控制台 GBK**：向 API 发中文 JSON 先落 UTF-8 文件再用 `curl --data-binary "@file"`；抓取 Python 输出加 `PYTHONIOENCODING=utf-8`。
- `[实测 2026-10-24 实验03]` **C51 指令级取证**：`.lst` 不含汇编，需用 `C51.EXE main.c "SRC(bench.src)" "INCDIR(C:/Keil_v5/C51/INC;.)" "OBJECT(x.obj)"` 生成汇编列表（仅诊断，不提交入库）。C51 对 16 位常量乘走 `?C?IMUL` 库（≈26 拍），`uchar × uchar` 才内联 `MUL AB`（4 拍）。
- `[实测]` **服务单实例**：`8765` 端口绑定失败 = 已有工作台实例在运行，先关旧进程再启。
- `[实测 2026-10-24]` **Edge 睡眠标签页防卡死**：后端 `Handler.timeout = 30`、SSE 心跳发真事件 `{"topic":"ping"}`、前端可见态 40s 无消息自动重连。

## 服务与 API 速查（`127.0.0.1:8765`）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/state` | 总状态（root、工具链可用性、串口、当前作业） |
| `GET` | `/api/ports` | 枚举本机串口 |
| `GET` | `/api/projects` | 扫描工作区全部 Keil 工程 |
| `GET` | `/api/hex?project=...` | 解析并校验工程输出的 `.hex`（含 0x0000 复位向量） |
| `GET` | `/api/files?dir=...` | 浏览工作区目录与源文件 |
| `GET` | `/api/job` | 获取当前或最近一次作业状态与结果 |
| `GET` | `/api/events` | SSE 实时事件流（串口、曲线、编译诊断、烧写进度） |
| `POST` | `/api/build` | `{project, rebuild}` 启动 Keil 编译作业 |
| `POST` | `/api/flash` | `{hex \| project, port, protocol, wait}` 启动 stcgal 烧写作业 |
| `POST` | `/api/serial/open` | `{port, baud=9600}` 打开串口监视 |
| `POST` | `/api/serial/close` | 关闭串口监视 |
| `POST` | `/api/serial/write` | `{text, newline=true}` 向串口发送文本 |
| `POST` | `/api/stop` | 作业停止说明 |
