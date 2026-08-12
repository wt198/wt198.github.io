# SivyBand Gen2 OTA Web Console

通过 Web Bluetooth 将 nRF54L15 Gen2 的 MCUboot 镜像上传到设备。

使用桌面 Chrome/Edge 打开本页面，或使用支持 Web Bluetooth 的 Android 浏览器。页面必须运行在 HTTPS 或 `localhost` 安全上下文中。

操作流程：

1. 点击“连接设备”，选择广播 SMP OTA 服务的 `SivyBand`。
2. 选择 OTA 构建生成的 `dfu_application.zip`；也支持 `zephyr.signed.bin`。
3. 点击“上传并测试”，等待页面读取槽位并标记非当前镜像为 test boot。
4. 检查槽位与哈希后点击“重启设备”。重启后重新连接并读取镜像状态。

OTA 使用标准 MCUmgr SMP over BLE：

- Service: `8d53dc1d-1db7-4cd3-868b-8a527460aa84`
- Characteristic: `da2e7828-fbce-4e01-ae9e-261174997c48`
- Image upload: group `1`, command `1`
- Image state: group `1`, command `0`
- Reset: group `0`, command `5`

OTA 文件只在浏览器内存中处理，不上传到服务器。当前固件使用开发阶段未认证 SMP 读写权限和默认签名密钥，仅限授权设备验证；量产前需要启用 BLE 加密/认证、私有签名密钥和回滚验收。
