# 规则依据与生成子集

这不是香色官方完整规范。以下语法从独立书源编辑器随附文档、模型定义与公开源样例交叉核对；模拟器提供可重复验证，iOS App 仍是最终兼容性判断依据。基线是公开资料里的 2.52+ 规则及 2.56.1 示例，不声称是 App 最新版本。

一手实现与示例（核对日期 2026-11-26）：

- source-reader `7d639151ad3796f4f59f7dddd5e621e96f80a685`：`src/views/nodes/components/NodeDocs.vue` 说明请求变量、模板、JSParser、列表上下文和分页；`src/utils/Models.ts` 定义编码与格式；`src/utils/xbsTool/xbsTools.ts` 定义 XXTEA 二进制格式。仓库：https://github.com/LinShengwzp/source-reader
- shuyuan-lab `f16539f69ddb1b56ee0b0a303efba0f42add83e2/demo.json`：22 个公开书源结构样例，含 HTML、JSONPath、单/双管道 JS。只核对格式，不把旧网址视为今天可用。仓库：https://github.com/urzeye/shuyuan-lab
- 公开写源实践：https://github.com/ckstc/XsRead ，2.56.1 请求、XPath 和 JS 说明。
- `xiangseSkill-main` 是对照资料；本包未复制其代码，未继承其推广和私有环境要求。

## 最小结构

以下是语法示意，example.invalid 不是已生成的站点，请根据采集到的真实页面替换。

```json
{
  "站点名": {
    "sourceName": "站点名",
    "sourceUrl": "https://example.invalid",
    "sourceType": "text",
    "enable": 1,
    "weight": "1000",
    "searchBook": {
      "actionID": "searchBook",
      "parserID": "DOM",
      "responseFormatType": "html",
      "requestInfo": "/search?q=%@keyWord&page=%@pageIndex",
      "list": "//ul[@id='results']/li",
      "bookName": "//a/text()",
      "detailUrl": "//a/@href"
    },
    "bookDetail": {
      "actionID": "bookDetail",
      "parserID": "DOM",
      "responseFormatType": "html",
      "requestInfo": "%@result",
      "bookName": "//h1/text()",
      "author": "//meta[@property='og:novel:author']/@content"
    },
    "chapterList": {
      "actionID": "chapterList",
      "parserID": "DOM",
      "responseFormatType": "html",
      "requestInfo": "%@result",
      "list": "//ol[@id='chapters']/li",
      "title": "//a/text()",
      "url": "//a/@href"
    },
    "chapterContent": {
      "actionID": "chapterContent",
      "parserID": "DOM",
      "responseFormatType": "html",
      "requestInfo": "%@result",
      "content": "//div[@id='content']/text()"
    }
  }
}
```

`weight` 字符串和 `enable:1/0` 是本包输出约定，不据此断言其它类型在所有 App 版本非法。`bookDetail` 可选字段以页面为准，但本包要求至少能解析书名以确认详情页正确。源名称应和外层键相同，每个文件一个源方便准确关联报告。

## 请求

`config.host` 来自该动作 `host`，未指定时来自 `sourceUrl`。`config.httpHeaders` 合并源和动作请求头。

URL 模板支持 `%@keyWord`（编码一次）、`%@pageIndex`（从 1 开始）、`%@offset`、`%@filter` 和 `%@result`（已解析的上级 URL）。复杂请求使用：

```javascript
@js:
var u = params.lastResponse && params.lastResponse.nextPageUrl;
return {
  url: u || config.host + '/search',
  POST: true,
  httpParams: {q: params.keyWord, page: params.pageIndex},
  httpHeaders: config.httpHeaders
};
```

- `POST:true`；传输字段是 `httpParams/httpHeaders`，不是 `method/data/headers`。
- params 有 `keyWord/pageIndex/offset/filter/filters/queryInfo/lastResponse/responseUrl`。响应 URL 在解析阶段有效；构造下一页应优先 `params.lastResponse.nextPageUrl`。
- 分类 `moreKeys.requestFilters` 支持名称值 map（例如 `{"古典":"1"}`，通过 `params.filter` 或 `%@filter` 取值）或 `[{"key":"class","items":[{"title":"全部","value":"0"}]}]`。多维形式按原始文档通过 **`params.filters.filters.class`** 取值，不是 `params.filters.class`；验证选择每个维度首项。
- `requestParamsEncode` 支持 `utf-8`、`2147485234`（GBK）；`responseEncode` 另支持 `2147485232`（GB2312）。未指定响应编码时从 HTTP/meta 探测。
- 不同域的真实接口经观察后配置动作 `host`；模拟器拒绝隐式跨动作 host 请求。联网采集只访问经 DNS 校验的公网地址，并逐次重定向重检；回环、内网和保留地址会被阻断。跨域重定向会改为 GET 并只保留安全头，不转发凭据、自定义头或请求体。
- Fixture 回放只读取清单目录中的普通文件；绝对路径、越界路径和指向目录外的符号链接会被拒绝。
- `cacheTime/tryCount/forbidCookie` 可保留；验证器始终直接请求、无自动 Cookie jar、无自动重试，以便暴露真实问题。

## 解析

HTML 使用 XPath 1.0。`list` 命中容器后，对每个独立节点片段用子规则 `//...`；不要在普通浏览器中直接对整页 evaluate 子字段当作验证。多个备选 XPath 用 `||`，首个非空结果生效；标准 XPath 的 `|` 仍是并集。

```text
//meta[@property='og:title']/@content || //h1/text()
//div[@id='content'] | @js: return String(result || '').replace(/广告文字/g, '').trim();
```

`|@js:` 与 `||@js:` 都作为末尾后处理；代码中的 `||` 不再当 XPath 分隔。普通字段合并多节点文本；正文保留 `<br>` 和段落换行，剔除脚本样式文本。未知扩展操作符会报 unsupported。

JSON 设置 `responseFormatType:"json"`，`list:"$.data.books[*]"`，子字段例如 `bookName:"$.name"`。JSONPath 不执行表达式过滤。`@js:` 后处理的 `result` 是前面选择结果；无前置选择器时是当前输入。

整页自定义：

```javascript
function functionName(config, params, result) {
  var obj = JSON.parse(result);
  return {list: obj.books.map(function (b) {
    return {bookName: b.name, detailUrl: config.host + '/book/' + b.id};
  })};
}
```

放到 `JSParser` 字段（`parserID` 仍用 `DOM`）。JSParser 的 result 是原始响应字符串；列表返回 `{list:[...]}`，详情返回书籍对象，正文返回字符串或 `{content:"..."}`。保留动作字段 `responseFormatType`。QuickJS 不提供 Node、浏览器或 `params.nativeTool`。

## 分页

目录与正文可以配置 `nextPageUrl` 和 `moreKeys:{maxPage:N}`。`requestInfo` 应支持工具传入的 lastResponse.nextPageUrl。验证会检查循环请求、重复章节链接和正文翻入另一章。它无法证明所有未知 URL 都属于同章，因此 agent 仍需基于站点地址结构编写守卫并核对样本。

正文守卫示意（仅适合已经验证为 `/book/书ID/章ID_页码.html` 的站）：

```javascript
//a[@id='next']/@href | @js:
var now = params.responseUrl.match(/\/(\d+)\/(\d+)(?:_(\d+))?\.html$/);
var next = String(result || '').match(/\/(\d+)\/(\d+)(?:_(\d+))?\.html$/);
if (!now || !next) return '';
return now[1] === next[1] && now[2] === next[2] && Number(next[3] || 1) > Number(now[3] || 1) ? result : '';
```

## 已实现边界

- 支持 DOM/html、DOM/json、纯字符串 JSParser、纯 JS 后处理、GET/表单 POST、UTF8/GBK、四步核心链路、按实际 URL 的目录/正文分页、分类 map 的每组首选项、XBS 加解密和回转。
- 未实现 WebView、媒体嗅探、App 原生工具/文件/加解密方法、持久 Cookie、复杂 validConfig、JSParser 的 autoRequestMore/response/removeHtmlKeys、非文本源、书单评论。出现相关字段会拒绝通过，而不是忽略。
- HTML list 节点后直接执行 JS 不可用；可用 XPath 谓词过滤或纯 JSParser。脚本有 32 MiB 内存和 250ms 单次执行上限；HTTP 20 秒、4 MiB 响应上限；验证总计最多 100 次请求、单动作 pageLimit 最多 50。
- 分类只测每组第一组筛选值；搜索只测给定关键字的第一页；目录全部解析；正文测试从所选索引开始的两章（短书只有一章时测一章）。所有通过结论必须带此覆盖范围。
- 生成文件严格使用本包支持字段。解码旧 XBS 会原样保留其它字段，但不能据此标记新验证通过。

## 「阅读」(Legado) 样本与生成子集

Legado 样本只引用用户指定仓库 `aoaostar/legado` 的小说“书源”区，不采用订阅源或其它仓库：[release commit `4643362b529b4efee26ee9411b8be7fdb27aec31`, README#id_0](https://github.com/aoaostar/legado/blob/4643362b529b4efee26ee9411b8be7fdb27aec31/README.md#id_0)。样本集合的 JSON 顶层为源对象数组；常见核心对象含 `bookSourceName/bookSourceUrl/bookSourceType/searchUrl/ruleSearch/ruleBookInfo/ruleToc/ruleContent`。更完整的样本计数和摘要见项目内 `research/legado-corpus.md`。

生成 spec 使用 `name/sourceUrl/searchUrl/ruleSearch/ruleBookInfo/ruleToc/ruleContent`，工具将其包装成单条数组 JSON，按样本设置普通源 `bookSourceType:0`、关闭 cookie/探索/评论。它只证明结构符合观察到的样本形状，不证明任一 App 导入校验。

首版转换子集只支持普通文本源、明确关闭 cookie/探索/评论、无登录、简单 GET 搜索模板 `{{key}}` 与纯 XPath/简单 JSONPath；允许字段映射：`bookName↔name`、`detailUrl↔bookUrl`、`desc↔intro`、`cover↔coverUrl`、`lastChapterTitle↔lastChapter`、`list↔bookList/chapterList`、`title↔chapterName`、`url↔chapterUrl`、`content↔content`。未能保留的探索/评论、登录/cookie、`tocUrl`、POST、分页、JS、CSS、Legado 自有选择器、过滤链或其它字段会逐源 `unsupported`，不丢弃后伪报成功。

命令示例：

```bash
node src/cli.mjs generate-legado --input legado-spec.json --output source.json
node src/cli.mjs verify --input source.json --format legado --mode schema
node src/cli.mjs verify --input source.json --format legado --mode live --keyword 测试书名 --output-dir .runtime/site
node src/cli.mjs batch-convert --from legado --to xiangse --input sources.json --output-dir .runtime/xiangse
node src/cli.mjs batch-convert --from xiangse --to legado --input .runtime/xiangse --output-dir .runtime/legado
```

批量目录必须是新的目录，报告逐源列出规则子集回转、元数据差异与 unsupported 原因。App 导入和运行仍为 `not_run`，不要把静态映射/本地 fixture 当成客户端行为等价。

## XBS

UTF-8 JSON 字节补零到 4 的倍数，尾部增加 uint32 little-endian 原文长度，再用标准 XXTEA（6+floor(52/n) 轮）处理。16 字节固定格式 key：`e587bce8a486e6bbbfe98791e6baa1e5`。这是文件格式封装，不是保护私人数据的加密方案。
