import { createHash } from 'node:crypto';

export const ACTIONS = ['searchBook', 'bookDetail', 'chapterList', 'chapterContent'];
export const BOOK_FIELDS = ['bookName', 'author', 'cover', 'desc', 'cat', 'status', 'wordCount', 'lastChapterTitle', 'detailUrl'];
export const FIELDS = {
  searchBook: BOOK_FIELDS,
  bookDetail: BOOK_FIELDS,
  chapterList: ['title', 'url', 'updateTime'],
  chapterContent: ['content', 'title'],
  bookWorld: BOOK_FIELDS,
};
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export class SourceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function httpUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new SourceError('fail', '只允许不含用户名/密码的 HTTP(S) URL');
  }
  return url.href;
}

// 这是本工具可验证的生成子集，不把第三方编辑器的默认值宣称为 App 全部规范。
export function validateSource(doc) {
  const errors = [], warnings = [];
  const add = (path, message) => errors.push({ path, message });
  if (!isObject(doc) || Object.keys(doc).length !== 1 || !isObject(Object.values(doc)[0])) {
    return { status: 'fail', errors: [{ path: '$', message: '每个生成文件必须恰好包含一个 {"站点名称": {...}} 书源' }], warnings };
  }
  const [alias, source] = Object.entries(doc)[0];
  if (source.sourceName !== alias || !alias.trim()) add('sourceName', '必须与非空外层名称相同');
  try { httpUrl(source.sourceUrl); } catch { add('sourceUrl', '必须是有效 HTTP(S) URL'); }
  if (source.sourceType !== 'text') add('sourceType', '当前只生成文本小说源，必须是 text');
  if (![0, 1].includes(source.enable)) add('enable', '生成约定为数字 0 或 1');
  if (typeof source.weight !== 'string' || !/^\d+$/.test(source.weight)) add('weight', '生成约定为非负整数字符串');
  if (source.lastModifyTime !== undefined && (typeof source.lastModifyTime !== 'string' || !/^\d+(\.\d+)?$/.test(source.lastModifyTime))) add('lastModifyTime', '应为 Unix 秒数字符串');
  for (const key of ['bookSourceName', 'bookSourceUrl', 'ruleSearch', 'ruleContent']) {
    if (key in source) add(key, '这是其它阅读器字段，不是香色规则');
  }
  function headers(value, path) {
    if (value === undefined || value === '') return;
    if (!isObject(value) || Object.values(value).some(v => typeof v !== 'string')) add(path, '请求头必须是字符串值的对象');
    else if (Object.keys(value).some(k => /^(cookie|authorization|proxy-authorization)$/i.test(k))) warnings.push({ path, message: '含凭据，请确认只在本机使用，不要分享' });
  }
  headers(source.httpHeaders, 'httpHeaders');
  function action(rule, id, path) {
    if (!isObject(rule)) { add(path, '缺少动作对象'); return; }
    if (rule.actionID !== id) add(`${path}.actionID`, `必须是 ${id}`);
    if (rule.parserID !== 'DOM') add(`${path}.parserID`, '当前验证器只支持 DOM（含 JSParser 覆盖）');
    if (!['html', 'json', 'str', ''].includes(rule.responseFormatType)) add(`${path}.responseFormatType`, '当前只支持 html/json/str/空字符串');
    if (rule.requestInfo !== undefined && typeof rule.requestInfo !== 'string') add(`${path}.requestInfo`, '必须是 URL 模板或 @js 字符串');
    if (id === 'searchBook' && !rule.requestInfo?.trim()) add(`${path}.requestInfo`, '搜索必须有真实请求');
    if (rule.validConfig !== undefined && rule.validConfig !== '') add(`${path}.validConfig`, '非空 validConfig 尚不能模拟，请使用空字符串');
    if (rule.JSParser) {
      if (typeof rule.JSParser !== 'string' || !/^\s*function\s+\w+\s*\(/.test(rule.JSParser)) add(`${path}.JSParser`, '需完整具名 function(config, params, result) 定义');
    } else {
      const required = ['searchBook', 'chapterList', 'bookWorld'].includes(id) ? ['list', ...(id === 'chapterList' ? ['title', 'url'] : ['bookName', 'detailUrl'])] : id === 'chapterContent' ? ['content'] : ['bookName'];
      for (const key of required) if (typeof rule[key] !== 'string' || !rule[key].trim()) add(`${path}.${key}`, '缺少非空解析规则');
    }
    for (const key of [...FIELDS[id], 'list', 'nextPageUrl']) if (rule[key] !== undefined && typeof rule[key] !== 'string') add(`${path}.${key}`, '解析规则必须是字符串');
    const supported = new Set(['actionID', 'parserID', 'host', 'httpHeaders', 'requestInfo', 'responseFormatType', 'requestParamsEncode', 'responseEncode', 'JSParser', 'moreKeys', 'validConfig', '_sIndex', 'list', 'nextPageUrl', ...FIELDS[id]]);
    for (const key of Object.keys(rule)) if (!supported.has(key)) add(`${path}.${key}`, '当前验证器未实现该字段，不会忽略后标记通过');
    headers(rule.httpHeaders, `${path}.httpHeaders`);
    if (rule.moreKeys !== undefined && !isObject(rule.moreKeys)) add(`${path}.moreKeys`, '必须是对象');
    else {
      for (const [key, val] of Object.entries(rule.moreKeys || {})) {
        if (!['maxPage', 'skipCount', 'pageSize', 'requestFilters'].includes(key)) add(`${path}.moreKeys.${key}`, '当前未实现的附加配置');
        if (['maxPage', 'pageSize', 'skipCount'].includes(key) && (!/^\d+$/.test(String(val)) || Number(val) < (key === 'skipCount' ? 0 : 1))) add(`${path}.moreKeys.${key}`, '必须是有效整数');
        if (key === 'requestFilters') {
          const scalar = value => ['string', 'number'].includes(typeof value);
          const valid = isObject(val) ? Object.keys(val).length > 0 && Object.values(val).every(scalar) : Array.isArray(val) && val.length > 0 && val.every(f => isObject(f) && typeof f.key === 'string' && f.key.trim() && Array.isArray(f.items) && f.items.length && f.items.every(i => isObject(i) && typeof i.title === 'string' && scalar(i.value)));
          if (!valid) add(`${path}.moreKeys.requestFilters`, '应为非空名称值 map 或 [{key,items:[{title,value}]}]');
        }
      }
    }
    if (rule.nextPageUrl && Number(rule.moreKeys?.maxPage || 1) <= 1) add(`${path}.moreKeys.maxPage`, '声明分页时应显式设置大于 1 的上限');
    if (id === 'chapterContent' && rule.nextPageUrl) warnings.push({ path: `${path}.nextPageUrl`, message: '必须以真实分页章和非分页章检查同章守卫；工具会拒绝翻到目录中另一章' });
  }
  for (const id of ACTIONS) action(source[id], id, id);
  if (source.bookWorld !== undefined) {
    if (!isObject(source.bookWorld) || !Object.keys(source.bookWorld).length) add('bookWorld', '分类必须是非空名称到动作的 map');
    else for (const [key, rule] of Object.entries(source.bookWorld)) action(rule, 'bookWorld', `bookWorld.${key}`);
  }
  for (const key of Object.keys(source)) {
    if (!['sourceName', 'sourceUrl', 'sourceType', 'enable', 'weight', 'lastModifyTime', 'desc', 'miniAppVersion', 'httpHeaders', ...ACTIONS, 'bookWorld'].includes(key)) add(key, '当前生成子集未实现该字段；解码可保留，生成验证不忽略');
  }
  return { status: errors.length ? 'fail' : 'pass', errors, warnings };
}

const key = Buffer.from('e587bce8a486e6bbbfe98791e6baa1e5', 'hex');
const KEY = Array.from({ length: 4 }, (_, i) => key.readUInt32LE(i * 4));
const DELTA = 0x9e3779b9;
function crypt(bytes, decrypt) {
  const v = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readUInt32LE(i * 4));
  const n = v.length;
  const rounds = 6 + Math.floor(52 / n);
  const mix = (y, z, p, e, sum) => ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (KEY[(p & 3) ^ e] ^ z)));
  if (decrypt) {
    let y = v[0], sum = (rounds * DELTA) >>> 0;
    for (let q = 0; q < rounds; q++) {
      const e = (sum >>> 2) & 3;
      for (let p = n - 1; p > 0; p--) y = v[p] = (v[p] - mix(y, v[p - 1], p, e, sum)) >>> 0;
      y = v[0] = (v[0] - mix(y, v[n - 1], 0, e, sum)) >>> 0;
      sum = (sum - DELTA) >>> 0;
    }
  } else {
    let z = v[n - 1], sum = 0;
    for (let q = 0; q < rounds; q++) {
      sum = (sum + DELTA) >>> 0;
      const e = (sum >>> 2) & 3;
      for (let p = 0; p < n - 1; p++) z = v[p] = (v[p] + mix(v[p + 1], z, p, e, sum)) >>> 0;
      z = v[n - 1] = (v[n - 1] + mix(v[0], z, n - 1, e, sum)) >>> 0;
    }
  }
  const out = Buffer.alloc(bytes.length);
  v.forEach((x, i) => out.writeUInt32LE(x, i * 4));
  return out;
}
export function encodeXbs(doc) {
  const plain = Buffer.from(JSON.stringify(doc), 'utf8');
  const bytes = Buffer.alloc(Math.ceil(plain.length / 4) * 4 + 4);
  plain.copy(bytes);
  bytes.writeUInt32LE(plain.length, bytes.length - 4);
  return crypt(bytes, false);
}
export function decodeXbs(bytes) {
  if (bytes.length < 8 || bytes.length % 4) throw new SourceError('fail', '无效 XBS 长度');
  const plain = crypt(bytes, true);
  const len = plain.readUInt32LE(plain.length - 4);
  if (len < plain.length - 7 || len > plain.length - 4) throw new SourceError('fail', 'XBS 尾部长度校验失败');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain.subarray(0, len)));
}
