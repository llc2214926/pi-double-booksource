import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { JSONPath } from 'jsonpath-plus';
import { getQuickJS } from 'quickjs-emscripten';
import iconv from 'iconv-lite';
import { FIELDS, SourceError, httpUrl, isObject } from './format.mjs';

export async function runJs(code, context, signal, fullFunction = false) {
  signal?.throwIfAborted();
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 250;
  runtime.setInterruptHandler(() => Date.now() > deadline || !!signal?.aborted);
  const vm = runtime.newContext();
  try {
    const prelude = `var config=${JSON.stringify(context.config || {})};var params=${JSON.stringify(context.params || {})};var result=${JSON.stringify(context.result ?? null)};`;
    const name = fullFunction && /^\s*function\s+(\w+)\s*\(/.exec(code)?.[1];
    if (fullFunction && !name) throw new SourceError('unsupported', 'JSParser 需要具名函数');
    const program = prelude + (fullFunction ? `${code}\n;${name}(config,params,result);` : `(function(){${code}\n})();`);
    const res = vm.evalCode(program);
    if (res.error) {
      const error = vm.dump(res.error);
      res.error.dispose();
      throw new SourceError(/nativeTool/.test(program) ? 'unsupported' : 'fail', `JS 执行失败: ${JSON.stringify(error)}`);
    }
    try { return vm.dump(res.value); } finally { res.value.dispose(); }
  } finally { vm.dispose(); runtime.dispose(); }
}

function nodeText(node, content) {
  if (node.nodeType === 2) return node.value;
  if (node.nodeType === 3) return node.textContent;
  const clone = node.cloneNode(true);
  clone.querySelectorAll?.('script,style,noscript').forEach(el => el.remove());
  if (content) {
    clone.querySelectorAll?.('br').forEach(el => el.replaceWith('\n'));
    clone.querySelectorAll?.('p,div,li,h1,h2,h3').forEach(el => el.append('\n'));
  }
  return clone.textContent || '';
}
const filled = value => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
function splitRule(rule) {
  const raw = String(rule || '').trim();
  if (raw.startsWith('@js:')) return { js: raw.slice(4), selectors: [] };
  const pipe = /\|{1,2}\s*@js:/.exec(raw);
  if (/\|\s*@replace:/.test(raw)) throw new SourceError('unsupported', '|@replace: 尚未模拟，请使用显式 |@js:');
  return { js: pipe ? raw.slice(pipe.index + pipe[0].length) : undefined, selectors: (pipe ? raw.slice(0, pipe.index) : raw).split(/\s*\|\|\s*/).filter(Boolean) };
}

function mergeHeaders(...headerMaps) {
  const headers = new Headers();
  for (const headerMap of headerMaps) for (const [name, value] of Object.entries(headerMap || {})) headers.set(name, value);
  return headers;
}

export async function parsePage(source, action, text, params = {}, signal) {
  const config = { ...action, host: action.host || source.sourceUrl, httpHeaders: { ...source.httpHeaders, ...action.httpHeaders } };
  const context = { config, params, result: text };
  let dom;
  try {
    let input = text;
    if (action.responseFormatType === 'json') input = JSON.parse(text);
    else if (action.responseFormatType === 'html') dom = new JSDOM(text);
    const document = dom?.window.document;
    function select(selector, current, nodes, content) {
      if (action.responseFormatType === 'json') return JSONPath({ path: selector, json: current, eval: false, wrap: true });
      if (!document) throw new SourceError('unsupported', '纯字符串响应请使用 @js 或 JSParser 解析');
      const result = current.evaluate(selector, current, null, dom.window.XPathResult.ANY_TYPE, null);
      if (result.resultType === 1) return [result.numberValue];
      if (result.resultType === 2) return [result.stringValue];
      if (result.resultType === 3) return [result.booleanValue];
      const values = [];
      for (let node = result.iterateNext(); node; node = result.iterateNext()) values.push(nodes ? node : nodeText(node, content));
      return values;
    }
    async function field(rule, current, nodes = false, content = false) {
      const { selectors, js } = splitRule(rule);
      let value = selectors.length ? '' : document ? (current === document ? text : current.documentElement.outerHTML) : current;
      for (const selector of selectors) {
        const values = select(selector, current, nodes, content);
        value = nodes ? values : values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(content ? '\n' : ' ');
        if (filled(value)) break;
      }
      if (js !== undefined) {
        if (nodes && document && selectors.length) throw new SourceError('unsupported', 'HTML list 后不支持 @js 转换 DOM 节点；请使用 XPath 过滤或 JSParser');
        value = await runJs(js, { ...context, result: value }, signal);
      }
      return value;
    }
    let output;
    if (action.JSParser) {
      const raw = await runJs(action.JSParser, context, signal, true);
      output = typeof raw === 'string' && action.actionID === 'chapterContent' ? { content: raw } : raw;
    } else if (action.list) {
      const items = await field(action.list, document || input, true);
      if (!Array.isArray(items)) throw new SourceError('fail', 'list 解析结果必须是数组');
      if (items.length > 5000) throw new SourceError('unsupported', '单页超过 5000 条，请缩小 list 选择器');
      const list = [];
      for (const item of items) {
        signal?.throwIfAborted();
        let current = item;
        if (document) {
          current = document.implementation.createHTMLDocument('');
          current.body.append(current.importNode(item, true));
        }
        const row = {};
        for (const key of FIELDS[action.actionID]) if (action[key]) row[key] = await field(action[key], current);
        list.push(row);
      }
      output = { list };
    } else {
      output = {};
      for (const key of FIELDS[action.actionID]) if (action[key]) output[key] = await field(action[key], document || input, false, key === 'content');
    }
    if (!isObject(output)) throw new SourceError('fail', '解析结果必须是对象');
    if ('response' in output || output.autoRequestMore || output.removeHtmlKeys) throw new SourceError('unsupported', 'JSParser 的 response/autoRequestMore/removeHtmlKeys 尚未模拟，请直接返回标准字段');
    if (output.success === false || output.error) throw new SourceError('fail', `解析器报告失败: ${output.error || 'success=false'}`);
    if (action.nextPageUrl && !action.JSParser) output.nextPageUrl = await field(action.nextPageUrl, document || input);
    if (Array.isArray(output.list)) {
      if (output.list.length > 5000) throw new SourceError('unsupported', '单页超过 5000 条，请缩小 list 选择器');
      output.list = output.list.slice(Number(action.moreKeys?.skipCount || 0));
    }
    const rows = output.list || [output];
    if (output.list && (!Array.isArray(output.list) || !output.list.length)) throw new SourceError('fail', '列表为空');
    for (const [index, row] of rows.entries()) {
      if (!isObject(row)) throw new SourceError('fail', `第 ${index + 1} 项不是对象`);
      const required = action.actionID === 'chapterList' ? ['title', 'url'] : action.actionID === 'chapterContent' ? ['content'] : ['bookName', ...(['searchBook', 'bookWorld'].includes(action.actionID) ? ['detailUrl'] : [])];
      for (const key of required) if (typeof row[key] !== 'string' || !row[key].trim()) throw new SourceError('fail', `第 ${index + 1} 项 ${key} 为空或不是字符串`);
      for (const [key, value] of Object.entries(row)) {
        if (typeof value !== 'string') continue;
        row[key] = key === 'content' ? value.replace(/\r\n?/g, '\n').trim() : value.replace(/\s+/g, ' ').trim();
        if (['detailUrl', 'url', 'cover'].includes(key) && row[key]) row[key] = httpUrl(row[key], params.responseUrl || config.host);
      }
    }
    if (output.nextPageUrl) output.nextPageUrl = httpUrl(output.nextPageUrl, params.responseUrl || config.host);
    if (output.content && /^(请稍后|网络开小差|访问过于频繁|请先登录|loading|access denied|just a moment)/i.test(output.content.trim())) throw new SourceError('blocked', '正文看起来是登录/限流占位信息');
    return output;
  } finally { dom?.window.close(); }
}

function encoding(value) {
  const enc = { '2147485232': 'gb2312', '2147485234': 'gbk' }[value] || value || 'utf-8';
  if (!iconv.encodingExists(enc)) throw new SourceError('unsupported', `不支持的编码 ${enc}`);
  return enc;
}
function encodedForm(data, enc) {
  const encode = value => [...iconv.encode(String(value), enc)].map(byte => /[a-zA-Z0-9*_.-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : byte === 32 ? '+' : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  return Object.entries(data).map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');
}
export async function buildRequest(source, action, params, result, signal) {
  const host = action.host || source.sourceUrl;
  const headers = mergeHeaders({ 'User-Agent': 'Mozilla/5.0 (compatible; pi-double-booksource/0.1)' }, source.httpHeaders, action.httpHeaders);
  let value = action.requestInfo || '%@result';
  const config = { ...action, host, httpHeaders: Object.fromEntries(headers) };
  if (value.trim().startsWith('@js:')) value = await runJs(value.trim().slice(4), { config, params, result }, signal);
  else value = value.replace(/%@(keyWord|pageIndex|offset|filters|filter|result)\b/g, (_, key) => key === 'result' ? String(result || '') : key === 'keyWord' ? encodedForm({ q: params[key] || '' }, encoding(action.requestParamsEncode)).slice(2).replace(/\+/g, '%20') : String(params[key] ?? ''));
  if (typeof value === 'string') value = { url: value };
  if (!isObject(value) || typeof value.url !== 'string') throw new SourceError('fail', 'requestInfo 必须返回 URL 或 {url,...}');
  const supported = new Set(['url', 'POST', 'httpParams', 'httpHeaders', 'forbidCookie', 'requestParamsEncode', 'responseEncode', 'responseFormatType', 'cacheTime', 'tryCount']);
  for (const key of Object.keys(value)) if (!supported.has(key)) throw new SourceError('unsupported', `不支持请求选项 ${key}；不能当作普通 HTTP 忽略`);
  if (value.POST !== undefined && typeof value.POST !== 'boolean') throw new SourceError('fail', 'POST 必须是布尔值');
  const url = new URL(httpUrl(value.url, host));
  if (url.origin !== new URL(host).origin) throw new SourceError('unsupported', `请求跨越动作 host：${url.origin}；核实后显式配置该动作 host`);
  if (value.httpHeaders) for (const [k, v] of Object.entries(value.httpHeaders)) headers.set(k, v);
  const responseEncode = value.responseEncode || action.responseEncode;
  const request = { url: url.href, method: value.POST ? 'POST' : 'GET', headers: Object.fromEntries(headers), responseEncode: responseEncode ? encoding(responseEncode) : undefined, responseFormatType: value.responseFormatType || action.responseFormatType };
  if (value.httpParams !== undefined) {
    if (!isObject(value.httpParams) || Object.values(value.httpParams).some(v => v !== null && typeof v === 'object')) throw new SourceError('unsupported', 'httpParams 只支持扁平对象');
    const form = encodedForm(value.httpParams, encoding(value.requestParamsEncode || action.requestParamsEncode));
    if (value.POST) {
      request.body = form;
      if (!headers.has('content-type')) request.headers['content-type'] = 'application/x-www-form-urlencoded';
    } else request.url += (url.search ? '&' : '?') + form;
  }
  return request;
}

const blockedIPv4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blockedIPv4.addSubnet(address, prefix, 'ipv4');
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blockedIPv6.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blockedIPv4.check(address, 'ipv4');
  return family === 6 && globalIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
}
async function resolvePublicAddress(url) {
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new SourceError('blocked', `拒绝请求非公网地址：${hostname}`);
  }
  return addresses[0];
}
export function headersForRedirect(headers) {
  const safe = new Headers();
  for (const name of ['accept', 'accept-encoding', 'accept-language', 'user-agent']) if (headers.has(name)) safe.set(name, headers.get(name));
  return safe;
}
function requestAt(target, request, signal, address) {
  const client = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = client(target, {
      method: request.method, headers: Object.fromEntries(request.headers), signal,
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, resolve);
    outgoing.once('error', reject);
    if (request.body !== undefined) outgoing.write(request.body);
    outgoing.end();
  });
}
export function redirectRequest(response, target, request) {
  const status = response.statusCode || 0;
  if (![301, 302, 303, 307, 308].includes(status) || typeof response.headers.location !== 'string') return;
  response.destroy();
  const next = new URL(httpUrl(response.headers.location, request.url));
  let { method, body, headers } = request;
  if (next.origin !== target.origin) {
    headers = headersForRedirect(headers);
    method = 'GET'; body = undefined;
  } else if (status === 303 || ([301, 302].includes(status) && method === 'POST')) {
    method = 'GET'; body = undefined;
    for (const key of ['content-type', 'content-length', 'transfer-encoding']) headers.delete(key);
  }
  return { ...request, url: next.href, method, body, headers };
}
function responseDecoder(encodingName) {
  if (encodingName === 'identity') return null;
  if (encodingName === 'gzip' || encodingName === 'x-gzip') return createGunzip();
  if (encodingName === 'deflate') return createInflate();
  if (encodingName === 'br') return createBrotliDecompress();
  return null;
}
async function readResponseBody(response, decoder) {
  let transferred = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    transferred += chunk.length;
    callback(transferred > 4 * 1024 * 1024 ? new SourceError('unsupported', '压缩响应超过 4 MiB') : null, chunk);
  } });
  const limited = response.pipe(limit);
  if (decoder) limit.once('error', error => decoder.destroy(error));
  const stream = decoder ? limit.pipe(decoder) : limited;
  const chunks = []; let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new SourceError('unsupported', '解压响应超过 4 MiB，请改用较小的接口或页面');
      chunks.push(chunk);
    }
  } catch (error) {
    response.destroy(); stream.destroy?.(); throw error;
  }
  return { bytes: Buffer.concat(chunks), size };
}
async function readResponse(response, request, url) {
  const contentType = response.headers['content-type'] || '';
  const contentEncoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  const decoder = responseDecoder(contentEncoding);
  if (contentEncoding !== 'identity' && !decoder) { response.destroy(); throw new SourceError('unsupported', `不支持 HTTP 压缩格式 ${contentEncoding}`); }
  const { bytes, size } = await readResponseBody(response, decoder);
  const charset = /charset\s*=\s*[\"']?([^\s;\"'>]+)/i;
  const hint = charset.exec(contentType)?.[1] || charset.exec(bytes.subarray(0, 2048).toString('ascii'))?.[1];
  const status = response.statusCode || 0;
  const text = iconv.decode(bytes, encoding(request.responseEncode || hint));
  if ([401, 403, 429].includes(status) || /<title[^>]*>\s*(Just a moment|Attention Required|安全验证|人机验证)/i.test(text) || /id=[\"']challenge-form[\"']/i.test(text)) throw new SourceError('blocked', `站点验证/限流阻断：HTTP ${status} ${url}`);
  if (status < 200 || status >= 300) throw new SourceError('fail', `HTTP ${status} ${url}`);
  return { url, text, httpStatus: status, encoding: encoding(request.responseEncode || hint), contentType, bytes: size };
}
export async function fetchPage(request, signal, resolveAddress = resolvePublicAddress) {
  const combined = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  const initial = httpUrl(request.url);
  const headers = new Headers(request.headers || {});
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');
  let current = { url: initial, method: String(request.method || 'GET').toUpperCase(), body: request.body, headers, responseEncode: request.responseEncode };
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(current.url);
    const address = await resolveAddress(target);
    const response = await requestAt(target, current, combined, address);
    const next = redirectRequest(response, target, current);
    if (next) { current = next; continue; }
    return readResponse(response, current, target.href);
  }
  throw new SourceError('fail', '重定向超过 5 次');
}
