import { randomUUID } from 'node:crypto';
import { isObject, httpUrl, SourceError, validateSource } from './format.mjs';

const required = {
  ruleSearch: ['bookList', 'name', 'bookUrl'],
  ruleBookInfo: ['name'],
  ruleToc: ['chapterList', 'chapterName', 'chapterUrl'],
  ruleContent: ['content'],
};
const allowedSourceKeys = new Set([
  'bookSourceName', 'bookSourceUrl', 'bookSourceType', 'bookSourceGroup', 'bookSourceComment', 'bookUrlPattern', 'customOrder',
  'enabled', 'enabledCookieJar', 'enabledExplore', 'enabledReview', 'lastUpdateTime', 'respondTime', 'weight', 'searchUrl', 'header',
  'exploreUrl', 'ruleExplore', 'ruleReview', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent',
  'concurrentRate', 'coverDecodeJs', 'exploreScreen', 'jsLib', 'loginCheckJs', 'loginUi', 'loginUrl', 'variableComment',
]);
const legadoToCore = {
  name: 'bookName', author: 'author', coverUrl: 'cover', intro: 'desc',
  kind: 'cat', wordCount: 'wordCount', lastChapter: 'lastChapterTitle',
};
const coreToLegado = Object.fromEntries(Object.entries(legadoToCore).map(([a, b]) => [b, a]));
const searchRules = ['bookList', 'name', 'bookUrl', ...Object.keys(legadoToCore), 'checkKeyWord'];
const detailRules = [...Object.keys(legadoToCore), 'tocUrl', 'init', 'canReName'];
const tocRules = ['chapterList', 'chapterName', 'chapterUrl', 'updateTime', 'nextTocUrl', 'isVip', 'isVolume', 'isPay', 'preUpdateJs'];
const contentRules = ['content', 'nextContentUrl', 'replaceRegex', 'imageStyle', 'sourceRegex', 'webJs', 'payAction', 'imageDecode'];
// 全量转换额外验证类型与不支持的非空扩展配置，空样本占位对象可保留。
const empty = value => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.values(value).every(empty));
const fail = (message, status = 'fail') => { throw new SourceError(status, message); };
const safeHeaderNames = new Set(['accept', 'accept-language', 'content-type', 'user-agent']);
const sensitiveHeader = key => !safeHeaderNames.has(key.toLowerCase());

export function legadoEntries(doc) {
  const entries = Array.isArray(doc) ? doc : [doc];
  if (!entries.length) fail('Legado 书源文件不能为空');
  return entries;
}

export function validateLegadoSource(source) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!isObject(source)) return { status: 'fail', errors: [{ path: '$', message: '书源必须是对象' }] };
  if (typeof source.bookSourceName !== 'string' || !source.bookSourceName.trim()) add('bookSourceName', '缺少书源名称');
  try { httpUrl(source.bookSourceUrl); } catch { add('bookSourceUrl', '必须是 HTTP(S) 网站地址'); }
  if (!Number.isInteger(source.bookSourceType)) add('bookSourceType', '样本使用整数类型');
  if (typeof source.enabled !== 'boolean') add('enabled', '样本使用布尔值');
  if (typeof source.searchUrl !== 'string' || !source.searchUrl.trim()) add('searchUrl', '缺少搜索请求');
  if (source.header !== undefined && typeof source.header !== 'string') add('header', '样本请求头是 JSON 字符串');
  if (source.bookSourceComment !== undefined && typeof source.bookSourceComment !== 'string') add('bookSourceComment', '样本备注为字符串');
  if (source.bookSourceGroup !== undefined && typeof source.bookSourceGroup !== 'string') add('bookSourceGroup', '样本分组为字符串');
  for (const key of ['enabledCookieJar', 'enabledExplore', 'enabledReview']) if (source[key] !== undefined && typeof source[key] !== 'boolean') add(key, '样本开关为布尔值');
  for (const key of ['customOrder', 'lastUpdateTime', 'respondTime']) if (source[key] !== undefined && !Number.isSafeInteger(source[key])) add(key, '样本该字段为整数');
  for (const [action, fields] of Object.entries(required)) {
    if (!isObject(source[action])) { add(action, '缺少规则对象'); continue; }
    for (const [field, value] of Object.entries(source[action])) if (typeof value !== 'string') add(`${action}.${field}`, '样本规则值为字符串');
    for (const field of fields) if (typeof source[action][field] !== 'string' || !source[action][field].trim()) add(`${action}.${field}`, '缺少非空规则');
  }
  return { status: errors.length ? 'fail' : 'pass', errors, appVerification: 'not_run', basis: 'aoaostar/legado release book-source sample shape; not an importer schema' };
}

function safeJsonPath(selector, list) {
  const key = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;
  const path = new RegExp(String.raw`^\$(?:\.${key}|\[\d+\])+(?:\[\*\])?$`);
  if (!path.test(selector) || /(?:^|\.)(?:__proto__|constructor|prototype)(?=\.|\[|$)/.test(selector)) return false;
  if (selector.includes('[*]')) return list;
  return list ? /\[\d+\]$/.test(selector) : true;
}
function safeXPathPath(selector) {
  const attribute = String.raw`@[A-Za-z_][\w:.-]*`;
  const literal = String.raw`(?:"[^"'<>]*"|'[^"'<>]*')`;
  const predicate = String.raw`\[(?:\d+|${attribute}\s*=\s*${literal}|contains\(\s*${attribute}\s*,\s*${literal}\s*\)|position\(\)\s*=\s*\d+)\]`;
  const step = String.raw`(?:[A-Za-z_][\w.:-]*|\*)(?:${predicate})*`;
  return new RegExp(String.raw`^(?:\/\/|\/)${step}(?:(?:\/\/|\/)${step})*$`).test(selector);
}
function portableRule(rule, path, shape = 'value') {
  if (typeof rule !== 'string' || !rule.trim()) fail(`${path}: 规则必须是非空字符串`);
  const alternatives = rule.trim().split(/\s*\|\|\s*/);
  const kinds = new Set();
  for (const selector of alternatives) {
    if (/##|&&|@css:|@js:|<js>|@get:|@put:|\[\s*\?\s*\(/i.test(selector)) fail(`${path}: 选择器含未支持的 Legado 扩展或可执行表达式`, 'unsupported');
    if (selector.startsWith('$')) {
      if (!safeJsonPath(selector, shape === 'list')) fail(`${path}: JSONPath 超出静态属性/数组路径子集`, 'unsupported');
      kinds.add('json');
      continue;
    }
    const scalar = /^(?:string|normalize-space)\((.*)\)$/.exec(selector);
    if (scalar) {
      const inner = scalar[1];
      const path = inner.endsWith('/text()') ? inner.slice(0, -7) : inner.replace(/\/@[A-Za-z_][\w:.-]*$/, '');
      if (shape === 'list' || !safeXPathPath(path)) fail(`${path}: XPath 标量不能作为列表，或不在简单路径子集`, 'unsupported');
      kinds.add('html');
      continue;
    }
    const textNode = selector.endsWith('/text()');
    const attribute = /\/@[A-Za-z_][\w:.-]*$/.test(selector);
    const xpath = textNode ? selector.slice(0, -7) : attribute ? selector.replace(/\/@[A-Za-z_][\w:.-]*$/, '') : selector;
    if (!safeXPathPath(xpath) || (shape === 'list' ? textNode || attribute : !textNode && !attribute)) fail(`${path}: XPath 结构无法证明返回${shape === 'list' ? '元素列表' : '字符串字段'}`, 'unsupported');
    kinds.add('html');
  }
  if (!alternatives.length || kinds.size !== 1) fail(`${path}: 同一规则只能使用 HTML XPath 或 JSONPath`, 'unsupported');
  return { rule: alternatives.join(' || '), format: [...kinds][0] };
}
const portableListRule = (rule, path) => portableRule(rule, path, 'list');
const portableValueRule = (rule, path) => portableRule(rule, path, 'value');

function checkRules(rule, allowed, path) {
  for (const key of Object.keys(rule || {})) {
    if (!allowed.includes(key)) fail(`${path}.${key}: 未识别的 Legado 规则字段`, 'unsupported');
    if (key === 'checkKeyWord' || ['tocUrl', 'init', 'canReName', 'nextTocUrl', 'isVip', 'isVolume', 'isPay', 'preUpdateJs', 'nextContentUrl', 'replaceRegex', 'imageStyle', 'sourceRegex', 'webJs', 'payAction', 'imageDecode'].includes(key)) {
      if (!empty(rule[key])) fail(`${path}.${key}: 该行为暂不支持转换`, 'unsupported');
    }
  }
}

function parseHeader(header) {
  if (empty(header)) return {};
  let result = header;
  if (typeof header === 'string') {
    try { result = JSON.parse(header); } catch { fail('header 不是有效 JSON 请求头', 'unsupported'); }
  }
  if (!isObject(result) || Object.values(result).some(value => typeof value !== 'string')) fail('header 只支持字符串值的请求头对象', 'unsupported');
  if (Object.keys(result).some(sensitiveHeader)) fail('敏感 header 不自动复制到另一个 App 的书源', 'unsupported');
  return result;
}

function uniqueMarker(value) {
  let marker;
  do marker = `PI_DOUBLE_KEY_${randomUUID()}`; while (value.includes(marker));
  return marker;
}

function legadoSearchTemplate(searchUrl, baseUrl) {
  if (typeof searchUrl !== 'string' || searchUrl.includes(',')) fail('searchUrl 只支持纯 GET URL；POST/JSON 请求选项暂不转换', 'unsupported');
  if (!searchUrl.includes('{{key}}')) fail('searchUrl 必须含唯一可映射的 {{key}} 搜索占位符', 'unsupported');
  if (/\{\{(?!key\}\})[^}]*\}\}/.test(searchUrl)) fail('searchUrl 含未支持的占位符', 'unsupported');
  const marker = uniqueMarker(searchUrl);
  const candidate = searchUrl.replaceAll('{{key}}', marker);
  if (candidate.includes('{{')) fail('searchUrl 含未支持的占位符', 'unsupported');
  let url;
  try { url = new URL(candidate, baseUrl); } catch { fail('searchUrl 不是有效 URL'); }
  if (url.username || url.password) fail('searchUrl 不得嵌入用户名或密码', 'unsupported');
  if (url.origin !== new URL(baseUrl).origin) fail('searchUrl 与 bookSourceUrl 跨域', 'unsupported');
  return url.href.replaceAll(marker, '%@keyWord');
}

function xiangseSearchTemplate(requestInfo, baseUrl) {
  if (typeof requestInfo !== 'string' || requestInfo.includes('@js:') || requestInfo.includes(',')) fail('searchBook.requestInfo 只支持纯 GET URL 模板', 'unsupported');
  if (!requestInfo.includes('%@keyWord')) fail('searchBook.requestInfo 必须含 %@keyWord', 'unsupported');
  if (/%@(?!keyWord\b)[A-Za-z]+/.test(requestInfo)) fail('searchBook.requestInfo 含未支持的变量', 'unsupported');
  const marker = uniqueMarker(requestInfo);
  const candidate = requestInfo.replaceAll('%@keyWord', marker);
  let url;
  try { url = new URL(candidate, baseUrl); } catch { fail('searchBook.requestInfo 不是有效 URL'); }
  if (url.username || url.password) fail('searchBook.requestInfo 不得嵌入用户名或密码', 'unsupported');
  if (url.origin !== new URL(baseUrl).origin) fail('searchBook.requestInfo 与 sourceUrl 跨域', 'unsupported');
  return url.href.replaceAll(marker, '{{key}}');
}

function formatFor(action, fields, path) {
  const formats = new Set();
  for (const field of fields) if (action[field]) {
    const rule = ['list', 'bookList', 'chapterList'].includes(field) ? portableListRule : portableValueRule;
    formats.add(rule(action[field], `${path}.${field}`).format);
  }
  if (formats.size !== 1) fail(`${path}: 同一动作只能使用 HTML XPath 或 JSONPath`, 'unsupported');
  return [...formats][0] === 'json' ? 'json' : 'html';
}
function checkRequest(action, path, sourceUrl, directResult = true) {
  if (directResult && action.requestInfo && action.requestInfo.trim() !== '%@result') fail(`${path}.requestInfo: 只支持直接使用上一页 URL`, 'unsupported');
  if (action.host) {
    try { if (new URL(action.host).href !== new URL(sourceUrl).href) fail(`${path}.host 与 sourceUrl 不完全一致`, 'unsupported'); }
    catch (error) { if (error instanceof SourceError) throw error; fail(`${path}.host 不是有效 URL`); }
  }
  if (action.moreKeys && !empty(action.moreKeys)) fail(`${path}.moreKeys: 分页、分类或附加请求选项暂不转换`, 'unsupported');
  if (action.nextPageUrl) fail(`${path}.nextPageUrl: 分页暂不转换`, 'unsupported');
  if (action.JSParser) fail(`${path}.JSParser: JavaScript 规则暂不转换`, 'unsupported');
  if (action.httpHeaders && !empty(action.httpHeaders)) fail(`${path}.httpHeaders: 动作级请求头不能无损映射`, 'unsupported');
}

export function legadoToXiangse(source) {
  const checked = validateLegadoSource(source);
  if (checked.status !== 'pass') fail(`Legado 结构校验失败: ${JSON.stringify(checked.errors)}`);
  for (const key of Object.keys(source)) if (!allowedSourceKeys.has(key) && !empty(source[key])) fail(`${key}: 未识别的源字段`, 'unsupported');
  if (source.enabledCookieJar !== false) fail('仅转换显式关闭 cookie jar 的源', 'unsupported');
  if (source.bookSourceType !== 0) fail(`bookSourceType=${source.bookSourceType} 不在普通文本源的转换子集中`, 'unsupported');
  if (source.enabledExplore !== false || source.enabledReview === true || !empty(source.exploreUrl) || !empty(source.ruleExplore) || !empty(source.ruleReview)) fail('探索/评论规则不在转换子集中', 'unsupported');
  for (const key of ['loginUrl', 'loginUi', 'loginCheckJs', 'bookUrlPattern', 'variableComment', 'concurrentRate', 'coverDecodeJs', 'exploreScreen', 'jsLib']) if (!empty(source[key])) fail(`${key}: 登录、变量、频率或 URL 匹配配置暂不转换`, 'unsupported');
  checkRules(source.ruleSearch, searchRules, 'ruleSearch');
  checkRules(source.ruleBookInfo, detailRules, 'ruleBookInfo');
  checkRules(source.ruleToc, tocRules, 'ruleToc');
  checkRules(source.ruleContent, contentRules, 'ruleContent');
  if (!empty(source.ruleBookInfo.tocUrl)) fail('ruleBookInfo.tocUrl: 与香色闺阁动作接口无法直接映射', 'unsupported');
  if (!empty(source.ruleToc.nextTocUrl) || !empty(source.ruleContent.nextContentUrl)) fail('目录或正文分页暂不转换', 'unsupported');

  const headers = parseHeader(source.header);
  const name = source.bookSourceName;
  const addFields = (rules, fields) => Object.fromEntries(fields.filter(([from]) => rules[from]).map(([from, to]) => {
    const ruleType = to === 'list' ? portableListRule : portableValueRule;
    return [to, ruleType(rules[from], `${name}.${from}`).rule];
  }));
  const makeAction = (actionID, rules, fields, requestInfo) => {
    const responseFormatType = formatFor(rules, fields.map(([from]) => from), `${name}.${actionID}`);
    return { actionID, parserID: 'DOM', responseFormatType, ...(requestInfo ? { requestInfo } : {}), ...addFields(rules, fields) };
  };
  const core = {
    sourceName: name, sourceUrl: httpUrl(source.bookSourceUrl), sourceType: 'text',
    enable: source.enabled ? 1 : 0, weight: String(Number.isFinite(source.weight) ? source.weight : 0),
    ...(source.bookSourceComment ? { desc: source.bookSourceComment } : {}),
    ...(Object.keys(headers).length ? { httpHeaders: headers } : {}),
    searchBook: makeAction('searchBook', source.ruleSearch, [['bookList', 'list'], ['name', 'bookName'], ['bookUrl', 'detailUrl'], ...Object.entries(legadoToCore)], legadoSearchTemplate(source.searchUrl, source.bookSourceUrl)),
    bookDetail: makeAction('bookDetail', source.ruleBookInfo, Object.entries(legadoToCore), '%@result'),
    chapterList: makeAction('chapterList', source.ruleToc, [['chapterList', 'list'], ['chapterName', 'title'], ['chapterUrl', 'url'], ['updateTime', 'updateTime']], '%@result'),
    chapterContent: makeAction('chapterContent', source.ruleContent, [['content', 'content']], '%@result'),
  };
  const doc = { [name]: core };
  const schema = validateSource(doc);
  if (schema.status !== 'pass') fail(`映射后的香色子集校验失败: ${JSON.stringify(schema.errors)}`);
  const metadataWarnings = ['bookSourceGroup', 'customOrder', 'lastUpdateTime', 'respondTime'].filter(key => source[key] !== undefined);
  return { doc, metadataWarnings };
}

export function xiangseToLegado(doc) {
  const schema = validateSource(doc);
  if (schema.status !== 'pass') fail(`香色结构校验失败: ${JSON.stringify(schema.errors)}`);
  const [alias, source] = Object.entries(doc)[0];
  if (source.bookWorld) fail('bookWorld 分类在首版 Legado 映射中不支持', 'unsupported');
  if (source.sourceType !== 'text') fail('只转换文本小说源', 'unsupported');
  const actions = ['searchBook', 'bookDetail', 'chapterList', 'chapterContent'];
  const fieldMaps = {
    searchBook: [['list', 'bookList'], ['bookName', 'name'], ['detailUrl', 'bookUrl'], ...Object.entries(coreToLegado)],
    bookDetail: Object.entries(coreToLegado),
    chapterList: [['list', 'chapterList'], ['title', 'chapterName'], ['url', 'chapterUrl'], ['updateTime', 'updateTime']],
    chapterContent: [['content', 'content']],
  };
  for (const id of actions) {
    const action = source[id];
    if (!['html', 'json'].includes(action.responseFormatType)) fail(`${id}: 只支持显式 HTML/JSON 规则`, 'unsupported');
    checkRequest(action, id, source.sourceUrl, id !== 'searchBook');
    if (action.responseEncode || action.requestParamsEncode) fail(`${id}: 显式编码设置无法确认与阅读等价`, 'unsupported');
    if (id === 'bookDetail' && action.detailUrl) fail('bookDetail.detailUrl 没有对应的 Legado 字段', 'unsupported');
    if (id === 'chapterContent' && action.title) fail('chapterContent.title 没有对应的 Legado 字段', 'unsupported');
    const fields = fieldMaps[id].map(([from]) => from).filter(key => action[key]);
    if (formatFor(action, fields, id) !== action.responseFormatType) fail(`${id}: responseFormatType 与选择器不一致`, 'unsupported');
  }
  const searchUrl = xiangseSearchTemplate(source.searchBook.requestInfo, source.sourceUrl);
  const headers = source.httpHeaders;
  if (headers && Object.keys(headers).some(sensitiveHeader)) fail('含敏感 httpHeaders 的源不自动复制凭据到阅读书源', 'unsupported');
  const numberWeight = Number(source.weight);
  const record = {
    bookSourceName: alias, bookSourceUrl: source.sourceUrl, bookSourceType: 0,
    enabled: source.enable === 1, enabledCookieJar: false, enabledExplore: false, enabledReview: false,
    customOrder: 0, lastUpdateTime: 0, respondTime: 180000,
    weight: Number.isSafeInteger(numberWeight) ? numberWeight : 0,
    searchUrl,
    ...(source.desc ? { bookSourceComment: source.desc } : {}),
    ...(headers && Object.keys(headers).length ? { header: JSON.stringify(headers) } : {}),
    ruleSearch: Object.fromEntries(fieldMaps.searchBook.filter(([from]) => source.searchBook[from]).map(([from, to]) => [to, (from === 'list' ? portableListRule : portableValueRule)(source.searchBook[from], `searchBook.${from}`).rule])),
    ruleBookInfo: Object.fromEntries(fieldMaps.bookDetail.filter(([from]) => source.bookDetail[from]).map(([from, to]) => [to, portableValueRule(source.bookDetail[from], `bookDetail.${from}`).rule])),
    ruleToc: Object.fromEntries(fieldMaps.chapterList.filter(([from]) => source.chapterList[from]).map(([from, to]) => [to, (from === 'list' ? portableListRule : portableValueRule)(source.chapterList[from], `chapterList.${from}`).rule])),
    ruleContent: Object.fromEntries(fieldMaps.chapterContent.filter(([from]) => source.chapterContent[from]).map(([from, to]) => [to, portableValueRule(source.chapterContent[from], `chapterContent.${from}`).rule])),
    ruleExplore: {}, ruleReview: {},
  };
  const checked = validateLegadoSource(record);
  if (checked.status !== 'pass') fail(`映射后的 Legado 样本结构校验失败: ${JSON.stringify(checked.errors)}`);
  const warning = [];
  if (source.lastModifyTime || source.miniAppVersion) warning.push('lastModifyTime/miniAppVersion 未映射');
  return { record, metadataWarnings: warning };
}

export function buildLegadoSource(spec) {
  if (!isObject(spec)) fail('Legado 生成输入必须是规则对象');
  const allowed = ['name', 'sourceUrl', 'searchUrl', 'header', 'weight', 'description', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'];
  for (const key of Object.keys(spec)) if (!allowed.includes(key)) fail(`生成输入 ${key} 未支持` , 'unsupported');
  if (spec.weight !== undefined && !Number.isSafeInteger(spec.weight)) fail('weight 必须是安全整数');
  if (spec.header !== undefined && (!isObject(spec.header) || Object.values(spec.header).some(value => typeof value !== 'string'))) fail('header 必须是字符串值的请求头对象');
  const record = {
    bookSourceName: spec.name, bookSourceUrl: spec.sourceUrl, bookSourceType: 0,
    bookSourceGroup: '', enabled: true, enabledCookieJar: false, enabledExplore: false, enabledReview: false,
    customOrder: 0, lastUpdateTime: 0, respondTime: 180000, weight: spec.weight ?? 0,
    searchUrl: spec.searchUrl, ruleSearch: spec.ruleSearch, ruleBookInfo: spec.ruleBookInfo,
    ruleToc: spec.ruleToc, ruleContent: spec.ruleContent, ruleExplore: {}, ruleReview: {},
    ...(spec.header ? { header: JSON.stringify(spec.header) } : {}),
    ...(spec.description ? { bookSourceComment: spec.description } : {}),
  };
  const checked = validateLegadoSource(record);
  if (checked.status !== 'pass') fail(`生成的 Legado 源不符合公开样本结构: ${JSON.stringify(checked.errors)}`);
  legadoToXiangse(record);
  return record;
}

function normalizeSearchRequest(source, id, requestInfo) {
  if (id !== 'searchBook') return requestInfo || '';
  try { return xiangseSearchTemplate(requestInfo, source.sourceUrl); }
  catch { return requestInfo || ''; }
}

export function coreProjection(doc) {
  const source = Object.values(doc)[0];
  return JSON.stringify({
    name: source.sourceName, sourceUrl: new URL(source.sourceUrl).href, sourceType: source.sourceType,
    enable: source.enable, weight: source.weight, desc: source.desc || '', httpHeaders: source.httpHeaders || {},
    actions: Object.fromEntries(['searchBook', 'bookDetail', 'chapterList', 'chapterContent'].map(id => {
      const action = source[id];
      return [id, { requestInfo: normalizeSearchRequest(source, id, action.requestInfo), responseFormatType: action.responseFormatType, ...Object.fromEntries(Object.keys(action).filter(k => !['actionID', 'parserID', 'requestInfo', 'responseFormatType', 'host', 'httpHeaders'].includes(k)).sort().map(k => [k, action[k]])) }];
    })),
  });
}
