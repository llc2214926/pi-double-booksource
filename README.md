# pi-double-booksource

给 agent 一个小说站点地址，让它采集网页、编写香色闺阁或「阅读」书源规则、验证并导出 JSON/XBS。支持严格子集的两种格式批量转换；格式文件生成不等于 App 内导入或运行验证。

## 安装

需要 Node.js 22.22.2+ 或 24.15.0+，Pi 1.6.1+。

```bash
cd /path/to/pi-double-booksource
npm install --omit=peer
pi install /path/to/pi-double-booksource
```

重新启动 Pi 或执行 `/reload`。想先试用，可在安装依赖后运行 `pi -e /path/to/pi-double-booksource`；这不会添加全局包设置。

## 使用

在 Pi 输入：

```text
/pi-double-booksource https://小说站点/ 测试书名
```

指定目标可写：

```text
/skill:pi-double-booksource 根据 https://小说站点/ 生成香色闺阁与「阅读」书源，说明可转换范围，用“测试书名”验证。
```

没有测试书名时，agent 会先从首页选取可读书籍。通常会得到：

- 可编辑的香色 JSON/XBS 或「阅读」书源 JSON，以及各自限制说明。
- 搜索、详情、目录、正文的请求/解析报告与样本快照。
- 批量互转逐源结果；不能等价映射的规则明确列为不支持。

核心工具：`pi_double_booksource_fetch` 采集站点；`pi_double_booksource_probe` 调试快照；`pi_double_booksource_verify` 验证书源子集；`pi_double_booksource_generate` 组装「阅读」书源样本格式；`pi_double_booksource_convert_batch` 双向批量转换严格子集；`pi_double_booksource_convert` 转换香色 XBS。

## 不加载插件也能用

保留完整包并安装依赖后，让 agent 读取 `skills/pi-double-booksource/SKILL.md`，使用同包 CLI：

```bash
node src/cli.mjs --help
node src/cli.mjs fetch --url https://小说站点/ --output home.html
node src/cli.mjs verify --input source.json --mode schema
node src/cli.mjs verify --input source.json --mode live --keyword 测试书名 --output-dir .runtime/site
node src/cli.mjs generate-legado --input legado-spec.json --output legado-source.json
node src/cli.mjs verify --input legado-source.json --format legado --mode schema
node src/cli.mjs batch-convert --from legado --to xiangse --input legado-sources.json --output-dir .runtime/xiangse
node src/cli.mjs batch-convert --from xiangse --to legado --input .runtime/xiangse --output-dir .runtime/legado
node src/cli.mjs batch-convert --from legado --to xiangse --input legado-sources.json --output-dir .runtime/xiangse-xbs --output-format xbs
node src/cli.mjs convert --input source.json --output source.xbs --direction encode --report .runtime/site/run-XXXXXX/report.json
node src/cli.mjs convert --input source.xbs --output decoded.json --direction decode
```

批量转换可传一个 Legado JSON 数组/单源文件，或含多个香色 JSON/XBS 的目录；输出必须是新目录，每源单独文件并写入 `report.json`。目录最多 200 个输入文件，单文件最多 32 MiB、整批最多 64 MiB，每批最多 5,000 条源。只映射本包支持的标准 XPath/简单 JSONPath 与 GET 模板；Legado 自定义选择器、CSS、POST、脚本、登录/cookie、探索/评论和分页会逐源标记不支持。

## 兼容范围与结果含义

针对公开香色书源规则和 `aoaostar/legado` 书源样本形状，支持香色 HTML XPath/JSONPath 与 XBS，并可生成基本「阅读」JSON。Legado 基于 [该仓库的小说书源样本](https://github.com/aoaostar/legado/tree/release#id_0)；批量转换仅支持字段对应明确、规则可原样保留的窄子集。对核对的四个公开集合，当前静态转换子集均没有自动通过的记录；很可能会将常见扩展规则报告为不支持，而不是伪称转换成功。

- `schema` 通过只表示本地生成子集/样本形状合法；不传联网报告的 XBS encode 仅生成草稿。
- `fixture` 通过表示已保存页面样本在本地解析器中可回放；`live` 通过表示所列网络模拟覆盖完成。
- Legado `pass` 只证明所支持字段子集可映射并通过本地结构回转，不是 Legado App 导入或规则行为实测；转换报告逐源列出不支持原因。
- `blocked` 是网络认证/风控/限流；`unsupported` 是当前运行时或格式子集不支持；`incomplete` 是分页未完成。

香色或「阅读」App 内导入、搜索、阅读和编辑保存仍需在目标客户端确认；本包不修改 App 书源库。联网采集只访问经 DNS 校验的公网地址，重定向也会重新校验；回环、局域网及保留地址会被阻断。Fixture 回放只读取清单目录内的普通文件，绝对路径、越界路径和指向目录外的符号链接会被拒绝。扩展工具结果超出上限时会标记 `truncated`；采集完整页面请指定 `output`，验证和批量转换的完整报告可按返回的 `reportFile` 读取。当前批量映射不支持 WebView、Legado 自定义/JavaScript 选择器、CSS、POST、分页、持久 Cookie、登录或付费内容链路，不保证任意站点和来源可转换。网站快照可能含私有信息，分享前请检查。

## 移除

```bash
pi remove /path/to/pi-double-booksource
```

## 许可

MIT。格式依据和独立参考项目见规则参考的来源说明。
