# SivyBand Gen2 OTA Web Console

用于通过 Web Bluetooth 将 nRF54L15 Gen2 的 MCUboot 镜像上传到设备。

## 适用固件

当前固件使用 Zephyr/NCS 标准 MCUmgr SMP over BLE：

- SMP service UUID: `8d53dc1d-1db7-4cd3-868b-8a527460aa84`
- SMP characteristic UUID: `da2e7828-fbce-4e01-ae9e-261174997c48`
- Image group / upload command: `1 / 1`
- Image group / state command: `1 / 0`
- OS group / reset command: `0 / 5`

固件通过 SMP UUID 广播 OTA 服务，设备名当前为 `SivyBand`。

## 使用方式

1. 使用 `tools\build_nrf54l15_ota.cmd` 构建 OTA 固件。
2. 在 Chrome 或 Edge 中打开 `index.html`。生产部署必须使用 HTTPS；本地开发可使用 `http://localhost`。
3. 点击“连接设备”，在浏览器设备选择器中选择 SivyBand。
4. 选择构建输出中的 `dfu_application.zip`，优先使用该文件；也支持 `zephyr.signed.bin`。
5. 点击“上传并测试”。网页会上传镜像、读取槽位状态并标记新镜像为 test boot。
6. 确认日志中的目标槽位和哈希后点击“重启设备”。设备重启后需要重新连接网页。
7. 重新连接后点击“读取镜像状态”，确认新镜像处于 active/confirmed 状态。

当前页面版本为 `20260820-cbor5-resume2`。页面启动日志必须显示：

```text
CBOR decoder self-test: PASS
```

该版本支持 SMP 响应中的不定长 CBOR 字节串、文本、数组和映射，并在 OTA 过程中执行以下恢复动作：

- 分块发送失败时最多重试 4 次。
- BLE GATT 意外断开时，使用已经选择的设备自动重连，最多尝试 3 次。
- 每个设备确认的 `off` 偏移都会保留在页面内存中；重连后从最后确认位置继续。
- 设备返回 `invalid offset` 时优先同步设备给出的期望偏移；设备上传上下文丢失时最多从零重启一次。
- 更换 OTA 文件时清零续传偏移，避免把旧镜像偏移用于新文件。

默认 OTA 构建输出目录为 `%LOCALAPPDATA%\SivyBand\build\gen2_nrf54l15_ota`：

```text
dfu_application.zip
app\zephyr\zephyr.signed.bin
merged.hex                 # 仅首次 SWD/J-Link 烧录，不用于 BLE OTA
```

## 浏览器与安全边界

- Web Bluetooth 需要用户主动打开设备选择器；网页不会后台扫描或保存设备列表。
- iOS/iPadOS Safari 不提供本流程所需的 Web Bluetooth API；使用桌面 Chrome/Edge 或支持 Web Bluetooth 的 Android 浏览器。
- OTA 文件只在当前页面内存中处理，不上传到服务器，也不写入本地存储。
- 自动重连和续传状态也只保存在当前页面内存中；刷新或关闭页面后需要重新选择文件并重新开始。
- 当前固件配置 `CONFIG_MCUMGR_TRANSPORT_BT_PERM_RW=y` 适合开发验证，不是量产安全配置。
- 量产前必须加入 BLE pairing/bonding、SMP 认证、私有签名密钥、固定分区策略和回滚验收。
- 只有明确确认镜像版本、设备和哈希后，才应执行“重启设备”。

## 参考

交互与 SMP over BLE 流程参考 `https://github.com/BestJourin/ASC-Web-Console`，本页面仅复用标准 OTA 协议思路，不复用其 Sivy-1 ASC 控制功能。
