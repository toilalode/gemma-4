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
//     Ở đây nhận thêm 4 giá trị: "auto", "gemma-4-31b-it", "gemma-4-26b-a4b-it", "thinking"
//     (= 31B + bật thinking). Chọn xong, đổi thành model Gemma thật trước khi gọi Gemini.
//
// Lưu ý: Nano Banana 2 Lite KHÔNG có free tier trên Gemini API (cần bật billing cho key).
import worker, { GeminiProxyDO, GeminiLiveDO } from './index.js';

const LITE_MARK = '[[nb-lite]]';
const LITE_MODEL = 'gemini-3.1-flash-lite-image';
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/';

const M31 = 'gemma-4-31b-it';
const M26 = 'gemma-4-26b-a4b-it';
const GEMMA_ALLOWED = [M31, M26];
const GEMMA_MARK_RE = /^\[\[gemma:([a-z0-9.-]+):([01])\]\]\s?/;

const HARD_HINTS = [
  'code', 'lập trình', 'debug', 'sửa lỗi', 'bug', 'function', 'thuật toán', 'sql', 'regex',
  'html', 'css', 'javascript', 'python', 'java', 'c++', 'api', 'json', 'script',
  'toán', 'chứng minh', 'đạo hàm', 'tích phân', 'xác suất',
  'phân tích', 'so sánh', 'giải thích', 'lý luận', 'đánh giá', 'chiến lược', 'nghiên cứu', 'tại sao', 'vì sao',
  'bài tập', 'bài toán', 'kế hoạch', 'viết bài', 'viết luận', 'tóm tắt',
];
function pickAuto(prompt) {
  const t = (prompt || '').toLowerCase();
  if (t.length > 300 || t.includes('```') || HARD_HINTS.some(k => t.includes(k))) return M31;
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

  // (3) /api/external/chat: dấu [[gemma:<model>:<0|1>]] do wrapper bên dưới gắn vào prompt.
  const mk = isPlainGenerate ? GEMMA_MARK_RE.exec(firstText) : null;
  if (mk && GEMMA_ALLOWED.includes(mk[1])) {
    first.text = firstText.slice(mk[0].length);
    url = url.replace(`/models/${model}:`, `/models/${mk[1]}:`);
    if (mk[2] === '1') body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: { thinkingLevel: 'high' } };
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

// Bọc fetch toàn cục (chạy cả trong Worker lẫn Durable Object GeminiProxyDO vì cùng nạp file này).
// Chỉ đụng tới request gửi tới generativelanguage.googleapis.com, mọi request khác đi thẳng như cũ.
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!url || !url.startsWith(GEMINI_HOST)) return originalFetch(input, init);
  try {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    return originalFetch(await patchGeminiRequest(req));
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
          const target = body.model === 'auto' ? pickAuto(body.prompt) : body.model === 'thinking' ? M31 : body.model;
          const think = body.model === 'thinking' ? '1' : '0';
          const headers = new Headers(request.headers);
          headers.delete('content-length');
          request = new Request(request.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, model: 'smart', prompt: `[[gemma:${target}:${think}]] ${body.prompt}` }),
          });
        }
      }
    } catch { /* lỗi bất ngờ -> chuyển nguyên request cho index.js */ }
    return worker.fetch.call(worker, request, env, ctx);
  },
};

export { GeminiProxyDO, GeminiLiveDO };
