# 采样工作台

一个面向自制音色的 Windows 多采样器原型，使用 Electron 和 Web Audio 构建。它是独立开发的项目，不包含 Kontakt 的代码或音色，也不是 Kontakt 8 的完整替代。

## 功能

- 导入 WAV，将多个采样映射到不同键区和力度范围，支持音区叠加。
- 设置每个音区的采样播放和循环范围，以及全局 ADSR 包络和音量。
- 使用全局低通滤波器调节声音的亮度和共振。
- 对每个音区独立设置音量、左右声像与微调；MIDI 弯音轮可在演奏时改变音高。
- 查看采样波形，编辑播放和循环位置；通过屏幕键盘、电脑键盘或 MIDI 输入演奏，支持 MIDI 延音踏板（CC64）。
- 将采样和设置保存为可移植工程文件，兼容打开旧版工程。

## 开发与打包

需要 Node.js 和 npm。在 Windows 上运行：

```sh
npm ci
npm start
```

运行自动测试：

```sh
npm test
node tests/multisample-e2e.mjs
node tests/midi-e2e.mjs
node tests/filter-e2e.mjs
node tests/close-guard-e2e.mjs
```

使用 `npm run package` 构建 Windows 安装包，输出位于 `release/`。构建产物和依赖不会提交到源码仓库。

更多使用步骤、支持的 WAV 格式和内存限制见 [使用说明](使用说明.md)。项目目前不支持 Kontakt 的 NCW/NKI、磁盘流、VST3、ASIO 专用驱动或 KSP 脚本。

每个版本的改进和验证记录见 [更新记录](CHANGELOG.md)。

不了解采样器的用途或想了解接下来要做什么，可以阅读 [产品方向与开发路线](产品路线.md)。
