// Điểm vào MỚI của worker (wrangler.toml -> main = "src/entry.js"). Chỉ bọc thêm, KHÔNG sửa index.js.
//
// Vì sao có file này: worker my-ai-worker được dùng chung với site gốc, nên không sửa logic trong
// index.js. Thay vào đó, file này vá nhẹ các request gửi tới Gemini API, và chỉ vá đúng 2 trường hợp
// mà site gốc không bao giờ tạo ra (nên site gốc chạy y như cũ):
//
//  1) Model Gemma 4 (gemma-*): index.js gửi thinkingConfig.thinkingBudget, còn Gemma 4 chỉ nhận
//     thinkingLevel ("high" = bật, "minimal" = tắt) -> đổi sang { thinkingLevel: 'high' }.
//     Tài liệu: https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
//
//  2) Nano Banana 2 Lite (gemini-3.1-flash-lite-image): route /api/image/generate chỉ biết 2 model
//     (thường / Pro). Frontend gắn dấu "[[nb-lite]]" ở đầu prompt khi người dùng bật Lite; ở đây
//     nhận ra dấu đó, bỏ dấu đi và đổi model trong URL sang bản Lite.
//
// Lưu ý: Nano Banana 2 Lite KHÔNG có free tier trên Gemini API (cần bật billing cho key).
import worker, { GeminiProxyDO, GeminiLiveDO } from './index.js';

const LITE_MARK = '[[nb-lite]]';
const LITE_MODEL = 'gemini-3.1-flash-lite-image';
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/';

async function patchGeminiRequest(req) {
  if (req.method !== 'POST') return req;
  const m = /\/models\/([^:/?]+):/.exec(req.url);
  if (!m) return req;
  const model = m[1];
  const isGemma = model.startsWith('gemma-');
  const isBaseImage = model === 'gemini-3.1-flash-image';
  if (!isGemma && !isBaseImage) return req;

  let body;
  try { body = await req.clone().json(); } catch { return req; }

  let url = req.url;
  let changed = false;

  if (isGemma) {
    const tc = body?.generationConfig?.thinkingConfig;
    if (tc && 'thinkingBudget' in tc) {
      body.generationConfig.thinkingConfig = { thinkingLevel: 'high' };
      changed = true;
    }
  } else {
    const first = body?.contents?.[0]?.parts?.[0];
    if (first && typeof first.text === 'string' && first.text.startsWith(LITE_MARK)) {
      first.text = first.text.slice(LITE_MARK.length).trimStart();
      url = url.replace(`/models/${model}:`, `/models/${LITE_MODEL}:`);
      changed = true;
    }
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

export { GeminiProxyDO, GeminiLiveDO };
export default worker;
