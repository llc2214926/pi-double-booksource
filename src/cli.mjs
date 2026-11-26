#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dispatch, filePath } from './workflow.mjs';

const help = `pi-double-booksource · 香色 / 阅读书源工具箱（与 Pi 扩展使用相同实现）

node src/cli.mjs fetch --url URL --output page.html
node src/cli.mjs probe --format xiangse|legado --input source.json --action searchBook --file page.html --url URL
node src/cli.mjs verify --format xiangse|legado --input source.json --mode schema [--source-index 0]
node src/cli.mjs verify --input source.json --mode live --keyword 书名 --output-dir .runtime/site
node src/cli.mjs verify --input source.json --mode fixture --keyword 书名 --fixtures PATH/fixtures.json --output-dir .runtime/replay
node src/cli.mjs generate-legado --input legado-spec.json --output source.json
node src/cli.mjs batch-convert --from legado|xiangse --to xiangse|legado --input file-or-dir --output-dir converted
node src/cli.mjs batch-convert --from legado --to xiangse --input booksources.json --output-dir converted --output-format xbs
node src/cli.mjs convert --input source.json --output source.xbs --direction encode --report PATH/report.json
node src/cli.mjs convert --input source.xbs --output decoded.json --direction decode

批量转换只支持样本证据覆盖的规则子集；逐源报告不支持项与元数据差异。App 导入/运行另记。输出已存在时拒绝覆盖。`;;
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  const keys = ['url', 'output', 'input', 'file', 'action', 'category', 'keyword', 'mode', 'output-dir', 'fixtures', 'book-index', 'chapter-index', 'page-limit', 'direction', 'report', 'params', 'headers', 'method', 'body', 'encoding', 'format', 'source-index', 'from', 'to', 'output-format'];
  const { values, positionals } = parseArgs({ options: Object.fromEntries([...keys.map(k => [k, { type: 'string' }]), ['help', { type: 'boolean', short: 'h' }]]), allowPositionals: true });
  if (values.help || !positionals.length) console.log(help);
  else {
    const [command] = positionals;
    const options = {};
    for (const [key, value] of Object.entries(values)) options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    for (const key of ['input', 'output', 'outputDir', 'file', 'fixtures', 'report']) if (options[key]) options[key] = filePath(options[key]);
    for (const key of ['headers', 'params']) if (options[key]) options[key] = JSON.parse(options[key]);
    for (const key of ['bookIndex', 'chapterIndex', 'pageLimit', 'sourceIndex']) if (options[key] !== undefined) {
      options[key] = Number(options[key]);
      if (!Number.isInteger(options[key]) || options[key] < (key === 'pageLimit' ? 1 : 0)) throw new Error(`${key} 必须为有效整数`);
    }
    const result = await dispatch(command, options, controller.signal);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'pass') process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ status: controller.signal.aborted ? 'cancelled' : error.status || 'fail', error: error.message }, null, 2));
  process.exitCode = 1;
}
