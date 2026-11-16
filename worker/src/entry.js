// Điểm vào MỚI của worker (wrangler.toml -> main = "src/entry.js"). Chỉ bọc thêm, KHÔNG sửa index.js.
//
// Vì sao có file này: worker my-ai-worker được dùng chung với site gốc, nên không sửa logic trong
// index.js. Thay vào đó, file này vá nhẹ các request, và chỉ vá những trường hợp mà site gốc không
// bao giờ tạo ra (nên site gốc chạy y như cũ):
//
//  1) Model Gemma 4 (gemma-*) trong chat: index.js gửi thinkingConfig.thinkingBudget, còn Gemma 4 chỉ
//     nhận thinkingLevel ("high" = bật) -> đổi sang { thinkingLevel: 'high' }.
//     Tài liệu: https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
//
//  2) Nano Banana 2 Lite (gemini-3.1-flash-lite-image): route /api/image/generate chỉ biết 2 model
//     (thường / Pro). Frontend gắn dấu "[[nb-lite]]" ở đầu prompt khi người dùng bật Lite; ở đây
//     nhận ra dấu đó, bỏ dấu đi và đổi model trong URL sang bản Lite.
//
//  3) API key bên ngoài (/api/external/chat): index.js chỉ biết 4 model smart/fast/lite/coding.
//     Ở đây nhận thêm: model = "auto" | "gemma-4-31b-it" | "gemma-4-26b-a4b-it" (hoặc "thinking" =
//     31B + thinking, giữ cho tương thích), cùng 2 trường tuỳ chọn:
//       thinking: true         -> bật thinking (dùng được cho CẢ 2 model)
//       systemPrompt: "..."    -> prompt hệ thống (systemInstruction)
//     Chọn xong, đổi thành model Gemma thật trước khi gọi Gemini.
//
//  4) Gemma hay trả lỗi 500 "Internal error encountered" (hoặc 400) khi request có tính năng nó không
//     xử lý được. Khi đó tự thử lại, mỗi lần bỏ bớt dần: thinking -> tìm web -> prompt hệ thống (gộp vào
//     tin nhắn đầu), cuối cùng thử model Gemma còn lại. Response có header x-gemma-fallback cho biết
//     đã phải bỏ đến bước nào (vd "no-thinking+no-tools").
//
// Lưu ý: Nano Banana 2 Lite KHÔNG có free tier trên Gemini API (cần bật billing cho key).
import worker, { GeminiProxyDO, GeminiLiveDO } from './index.js';

const LITE_MARK = '[[nb-lite]]';
const LITE_MODEL = 'gemini-3.1-flash-lite-image';
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/';

const M31 = 'gemma-4-31b-it';
const M26 = 'gemma-4-26b-a4b-it';
const GEMMA_ALLOWED = [M31, M26];
// [[gemma:<model>:<0|1 thinking>:<system prompt base64url, có thể rỗng>]]
const GEMMA_MARK_RE = /^\[\[gemma:([a-z0-9.-]+):([01]):([A-Za-z0-9_-]*)\]\]\s?/;
const MAX_SYSTEM_CHARS = 4000;

function toB64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(b64) {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

const HARD_HINTS = [
  'code', 'lập trình', 'debug', 'sửa lỗi', 'bug', 'function', 'thuật toán', 'sql', 'regex',
  'html', 'css', 'javascript', 'python', 'java', 'c++', 'api', 'json', 'script',
  'toán', 'chứng minh', 'đạo hàm', 'tích phân', 'xác suất',
  'phân tích', 'so sánh', 'giải thích', 'lý luận', 'đánh giá', 'chiến lược', 'nghiên cứu', 'tại sao', 'vì sao',
  'bài tập', 'bài toán', 'kế hoạch', 'viết bài', 'viết luận', 'tóm tắt',
];
function pickAuto(prompt, thinking) {
  const t = (prompt || '').toLowerCase();
  if (thinking || t.length > 300 || t.includes('```') || HARD_HINTS.some(k => t.includes(k))) return M31;
  return M26;
}

async function patchGeminiRequest(req) {
  if (req.method !== 'POST') return req;
  const m = /\/models\/([^:/?]+):([A-Za-z]+)/.exec(req.url);
  if (!m) return req;
  const model = m[1];
  const action = m[2];
  const isGemma = model.startsWith('gemma-');
  const isBaseImage = model === 'gemini-3.1-flash-image';
  const isPlainGenerate = action === 'generateContent' && !model.includes('image');
  if (!isGemma && !isBaseImage && !isPlainGenerate) return req;

  let body;
  try { body = await req.clone().json(); } catch { return req; }

  let url = req.url;
  let changed = false;
  const first = body?.contents?.[0]?.parts?.[0];
  const firstText = first && typeof first.text === 'string' ? first.text : '';

  // (3) /api/external/chat: dấu do wrapper bên dưới gắn vào prompt.
  const mk = isPlainGenerate ? GEMMA_MARK_RE.exec(firstText) : null;
  if (mk && GEMMA_ALLOWED.includes(mk[1])) {
    first.text = firstText.slice(mk[0].length);
    url = url.replace(`/models/${model}:`, `/models/${mk[1]}:`);
    if (mk[2] === '1') body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: { thinkingLevel: 'high' } };
    if (mk[3]) {
      try { body.systemInstruction = { parts: [{ text: fromB64Url(mk[3]) }] }; } catch { /* bỏ qua prompt hệ thống lỗi */ }
    }
    changed = true;
  } else if (isGemma) {
    // (1) chat: thinkingBudget -> thinkingLevel
    const tc = body?.generationConfig?.thinkingConfig;
    if (tc && 'thinkingBudget' in tc) {
      body.generationConfig.thinkingConfig = { thinkingLevel: 'high' };
      changed = true;
    }
  } else if (isBaseImage && firstText.startsWith(LITE_MARK)) {
    // (2) ảnh: Nano Banana 2 Lite
    first.text = firstText.slice(LITE_MARK.length).trimStart();
    url = url.replace(`/models/${model}:`, `/models/${LITE_MODEL}:`);
    changed = true;
  }

  if (!changed) return req;
  return new Request(url, { method: 'POST', headers: req.headers, body: JSON.stringify(body) });
}

// (4) Gọi Gemma, nếu lỗi 5xx (hoặc 400 không phải do API key) thì thử lại với request đơn giản hơn.
async function gemmaFetchWithFallback(req) {
  const firstRes = await originalFetch(req.clone());
  const shouldRetry = async (res) => {
    if (res.status >= 500) return true;
    if (res.status === 400) {
      const txt = await res.clone().text().catch(() => '');
      return !/api key|API_KEY/i.test(txt);
    }
    return false;
  };
  if (!(await shouldRetry(firstRes))) return firstRes;

  let body;
  try { body = await req.clone().json(); } catch { return firstRes; }

  const withoutThinking = (b) => {
    if (b.generationConfig) {
      delete b.generationConfig.thinkingConfig;
      if (!Object.keys(b.generationConfig).length) delete b.generationConfig;
    }
  };
  const foldSystem = (b) => {
    const sys = b.systemInstruction?.parts?.map(p => p.text || '').join('\n').trim();
    delete b.systemInstruction;
    const p0 = b.contents?.[0]?.parts?.[0];
    if (sys && p0 && typeof p0.text === 'string') p0.text = `${sys}\n\n${p0.text}`;
  };

  const steps = [];
  if (body.generationConfig?.thinkingConfig) steps.push(['no-thinking', (b) => withoutThinking(b)]);
  if (body.tools) steps.push(['no-tools', (b) => { delete b.tools; }]);
  if (body.systemInstruction) steps.push(['no-system', (b) => foldSystem(b)]);

  const cur = structuredClone(body);
  const applied = [];
  const send = (b, url) => originalFetch(new Request(url, { method: 'POST', headers: req.headers, body: JSON.stringify(b) }));
  const tag = (res, label) => {
    const out = new Response(res.body, res);
    out.headers.set('x-gemma-fallback', label);
    return out;
  };

  for (const [label, fn] of steps) {
    fn(cur);
    applied.push(label);
    const res = await send(cur, req.url);
    if (!(await shouldRetry(res))) return tag(res, applied.join('+'));
  }

  // Cuối cùng: thử model Gemma còn lại với request đã đơn giản hoá.
  const mm = /\/models\/(gemma-[^:/?]+):/.exec(req.url);
  if (mm) {
    const other = mm[1] === M31 ? M26 : M31;
    const res = await send(cur, req.url.replace(`/models/${mm[1]}:`, `/models/${other}:`));
    if (!(await shouldRetry(res))) return tag(res, [...applied, 'other-model'].join('+'));
  }
  return firstRes; // vẫn lỗi -> trả đúng lỗi ban đầu để người dùng thấy nguyên nhân thật
}

// Bọc fetch toàn cục (chạy cả trong Worker lẫn Durable Object GeminiProxyDO vì cùng nạp file này).
// Chỉ đụng tới request gửi tới generativelanguage.googleapis.com, mọi request khác đi thẳng như cũ.
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!url || !url.startsWith(GEMINI_HOST)) return originalFetch(input, init);
  try {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    const patched = await patchGeminiRequest(req);
    if (patched.method === 'POST' && /\/models\/gemma-/.test(patched.url)) return await gemmaFetchWithFallback(patched);
    return originalFetch(patched);
  } catch {
    return originalFetch(input, init);
  }
};

// (3) Bọc worker.fetch: đổi model "auto" / gemma / "thinking" của /api/external/chat thành "smart" +
// dấu trong prompt, để index.js (không biết các giá trị này) vẫn chạy bình thường; fetch bọc ở trên
// sẽ đổi sang model Gemma thật.
const EXTERNAL_VALUES = ['auto', M31, M26, 'thinking'];
export default {
  ...worker,
  async fetch(request, env, ctx) {
    try {
      const u = new URL(request.url);
      if (request.method === 'POST' && u.pathname === '/api/external/chat') {
        const body = await request.clone().json().catch(() => null);
        if (body && typeof body.prompt === 'string' && EXTERNAL_VALUES.includes(body.model)) {
          const think = body.model === 'thinking' || body.thinking === true;
          const target = body.model === 'auto' ? pickAuto(body.prompt, think) : body.model === 'thinking' ? M31 : body.model;
          const sys = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim().slice(0, MAX_SYSTEM_CHARS) : '';
          const headers = new Headers(request.headers);
          headers.delete('content-length');
          const { systemPrompt, thinking, ...rest } = body;
          request = new Request(request.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...rest, model: 'smart', prompt: `[[gemma:${target}:${think ? 1 : 0}:${sys ? toB64Url(sys) : ''}]] ${body.prompt}` }),
          });
        }
      }
    } catch { /* lỗi bất ngờ -> chuyển nguyên request cho index.js */ }
    return worker.fetch.call(worker, request, env, ctx);
  },
};

export { GeminiProxyDO, GeminiLiveDO };
