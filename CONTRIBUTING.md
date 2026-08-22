# 贡献指南 Contributing

欢迎给 `dsh-tts-reader` 提 Issue / PR！感谢你的时间。

## 提交 PR 的流程

1. **Fork** 本仓库到你的 GitHub 账号
2. 建分支：`git checkout -b feat/my-change`
3. 改代码（结构见下），本地自测
4. 提交：`git commit`（提交信息用简洁英文，说明改动意图）
5. 推到你 fork：`git push -u origin feat/my-change`
6. 提交 **Pull Request**，描述：改了什么、为什么、怎么测的

> 提交 PR 即视为按本仓库的 [MIT](./LICENSE) 协议授权贡献。

## 代码结构

```
dsh-tts-reader/
├── package.json        # 插件声明：dsh.client(web) + dsh.bundle 自激活 patch
├── cordis.patch.yml    # bundle patch：把插件插进 profile 插件树（自激活）
└── lib/
    ├── index.js        # 宿主半边（Node）——空 apply() 占位，让包进入 Loader
    └── client.js       # 浏览器半边（核心）——全部 UI 逻辑
```

## 本地调试

- 改 `lib/client.js` → 刷新 dsh web 页面即生效（宿主按请求从磁盘读取，无需重启）
- 首次安装或改 patch/依赖 → 需重启宿主
- 建议在个人 dsh profile 用 `dsh plugin --profile web add "link:<本仓库路径>"` 挂本地开发副本

## 约定

- 代码中 `BUG-xxx` / `ENH-xxx` 注释是**迭代留痕**（解释某段代码为什么这么写），请保持并沿用编号
- 保持**零依赖**（只用浏览器 Web Speech API），不引入构建工具
- 中文注释为主；面向用户的文案（按钮标题、设置项）可中英兼顾
