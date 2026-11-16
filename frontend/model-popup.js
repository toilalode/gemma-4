// ===================== POPUP MODEL + BẬT/TẮT THINKING =====================
// Nạp SAU app.js. Dùng lại các thứ app.js đã có: state, els, MODEL_OPTIONS, modelSheet, modelBackdrop,
// renderModelSheet(), openSheet(), closeSheet() — nên không phải sửa app.js.
//
// Cách hoạt động:
//  - Bấm tên model ở ô nhập -> mở popup này.
//  - Góc trên trái: tia sét. Rỗng = TẮT thinking, tô màu = BẬT thinking.
//  - Giữa: tên model, bấm vào để đổi model.
//  - Góc trên phải: nút X đóng popup.
//  - Không còn thanh mức nỗ lực.
(() => {
  'use strict';

  const BOLT_PATH = 'M13 2 4.5 13.5H11L10 22l9-12h-6.5z';
  const boltSvg = (cls) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${BOLT_PATH}"/></svg>`;

  // ---------- dựng popup ----------
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop hidden';
  backdrop.id = 'effortBackdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet effort-sheet';
  sheet.id = 'effortSheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Model và thinking');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="effort-header">
      <button type="button" class="effort-bolt" id="effortBolt" aria-pressed="false" aria-label="Bật hoặc tắt thinking" title="Thinking">${boltSvg('')}</button>
      <button type="button" class="effort-model" id="effortModelBtn" aria-label="Đổi model">
        <span id="effortModelName"></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <button type="button" class="effort-close" id="effortClose" aria-label="Đóng">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>`;
  document.body.append(backdrop, sheet);

  const boltBtn = sheet.querySelector('#effortBolt');
  const modelBtn = sheet.querySelector('#effortModelBtn');
  const modelName = sheet.querySelector('#effortModelName');

  // ---------- trạng thái ----------
  function currentModel() {
    const all = [...MODEL_OPTIONS, CODING_MODEL_OPTION];
    return all.find(m => m.value === state.model) || MODEL_OPTIONS[0];
  }

  function refresh() {
    const on = !!state.thinking;
    boltBtn.classList.toggle('on', on);
    boltBtn.setAttribute('aria-pressed', String(on));
    modelName.textContent = currentModel().label.replace(/^\u26A1\uFE0F?\s*/u, '') || currentModel().label;
  }

  // Bật/tắt thinking thông qua công tắc cũ (đang ẩn) để app.js tự lưu state + localStorage như trước.
  function setThinking(on) {
    const t = els.thinkingToggle;
    if (t.checked !== on) {
      t.checked = on;
      t.dispatchEvent(new Event('change'));
    }
    refresh();
  }

  // ---------- sự kiện ----------
  boltBtn.addEventListener('click', () => setThinking(!state.thinking));

  const close = () => closeSheet(sheet, backdrop);
  sheet.querySelector('#effortClose').addEventListener('click', close);
  backdrop.addEventListener('click', close);

  // Bấm tên model trong popup -> đóng popup này, mở popup chọn model.
  modelBtn.addEventListener('click', () => {
    close();
    renderModelSheet();
    openSheet(modelSheet, modelBackdrop);
  });

  // Bấm tên model ở ô nhập: chặn ở pha capture của document để app.js không mở popup cũ nữa.
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#modelPillBtn')) {
      e.stopPropagation();
      e.preventDefault();
      refresh();
      openSheet(sheet, backdrop);
    }
  }, true);

  // ---------- nối với app.js (không sửa app.js) ----------
  // Nhãn trên nút model: icon tia sét tô màu khi đang bật thinking.
  window.updateModelPillLabel = function () {
    const m = currentModel();
    const lbl = els.modelPillLabel;
    lbl.textContent = '';
    if (state.thinking) lbl.insertAdjacentHTML('beforeend', boltSvg('pill-bolt'));
    lbl.append(m.label);
    refresh();
  };

  window.updateModelPillLabel(); // đồng bộ nhãn ngay khi tải trang
})();

// ===================== GEMMA 4 =====================
// Chỉ thay: danh sách model + Auto + system prompt. Mọi thứ khác (worker dùng chung my-ai-worker,
// tìm web, thinking, lưu hội thoại...) giữ nguyên như bản gốc.
(() => {
  'use strict';

  const M31 = 'gemma-4-31b-it';       // thông minh nhất
  const M26 = 'gemma-4-26b-a4b-it';   // nhanh hơn (MoE, ~4B tham số hoạt động)

  // Tên model theo tài liệu Gemini API: https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
  const GEMMA_MODELS = [
    { value: 'auto', label: '⚡ Auto', desc: 'Tự chọn giữa Gemma 4 31B và 26B tuỳ theo từng câu hỏi' },
    { value: M31, label: 'Gemma 4 31B', desc: 'Thông minh nhất, hợp câu hỏi khó và suy luận' },
    { value: M26, label: 'Gemma 4 26B A4B', desc: 'Nhanh hơn, hợp câu hỏi đơn giản' },
  ];

  // Thay nội dung danh sách tại chỗ để mọi code cũ vẫn dùng đúng mảng MODEL_OPTIONS.
  MODEL_OPTIONS.splice(0, MODEL_OPTIONS.length, ...GEMMA_MODELS);

  // Model đã lưu từ bản cũ (gemini-*) không còn trong danh sách -> về Auto.
  if (!GEMMA_MODELS.some(m => m.value === state.model)) {
    state.model = 'auto';
    localStorage.setItem('myai_model', state.model);
  }

  document.title = 'Gemma 4 Chat';

  // ---------- Auto: chọn 31B hay 26B theo câu hỏi ----------
  // Câu khó (code, toán, phân tích, dài, có file đính kèm, bật tìm web hoặc thinking) -> 31B.
  // Câu ngắn, đơn giản (chào hỏi, hỏi nhanh, dịch ngắn...) -> 26B cho nhanh.
  const HARD_HINTS = [
    'code', 'lập trình', 'debug', 'sửa lỗi', 'bug', 'function', 'hàm ', 'thuật toán', 'sql', 'regex',
    'html', 'css', 'javascript', 'python', 'java', 'c++', 'api', 'json', 'script',
    'toán', 'giải phương trình', 'chứng minh', 'tính ', 'đạo hàm', 'tích phân', 'xác suất',
    'phân tích', 'so sánh', 'giải thích', 'lý luận', 'đánh giá', 'chiến lược', 'nghiên cứu', 'tại sao', 'vì sao',
    'bài tập', 'bài toán', 'kế hoạch', 'viết bài', 'viết luận', 'tóm tắt', 'dịch bài',
  ];
  function pickAutoModel(text, { webSearch, thinking, hasFiles }) {
    const t = (text || '').toLowerCase();
    if (hasFiles || webSearch || thinking) return M31;
    if (t.length > 300 || t.includes('```')) return M31;
    if (HARD_HINTS.some(k => t.includes(k))) return M31;
    return M26;
  }

  function buildSystemPrompt(tutorMode) {
    const today = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const parts = [
      'Bạn là Gemma 4, một trợ lý AI hữu ích, trung thực và chu đáo. Hôm nay là ' + today + '.',
      'Trả lời bằng ngôn ngữ người dùng đang dùng (mặc định tiếng Việt). Đi thẳng vào câu trả lời, giọng tự nhiên, ấm áp, không dài dòng.',
      'Câu hỏi đơn giản thì trả lời ngắn. Chỉ dùng danh sách, bảng hay tiêu đề khi nội dung thật sự nhiều phần; code luôn đặt trong khối code có ghi ngôn ngữ.',
      'Nếu không chắc hoặc không biết thì nói rõ, không bịa số liệu, nguồn hay trích dẫn. Nếu câu hỏi mơ hồ, hãy nêu giả định hợp lý rồi trả lời, hoặc hỏi lại đúng một câu.',
      'Khi có kết quả tìm kiếm web, ưu tiên thông tin mới nhất, nêu rõ nguồn, và nói rõ khi các nguồn mâu thuẫn nhau.',
      'Từ chối nhẹ nhàng các yêu cầu gây hại hoặc vi phạm pháp luật và đề xuất hướng an toàn thay thế.',
    ];
    if (tutorMode) parts.push('Đang ở chế độ gia sư: giải thích từng bước, chỉ cách tư duy, rồi mới chốt đáp án cuối cùng.');
    return parts.join('\n');
  }

  // Bọc streamPost: thay system prompt cũ bằng prompt mới, và đổi 'auto' thành model Gemma cụ thể
  // (worker gốc chỉ biết Auto của Gemini nên phải chọn ở đây trước khi gửi).
  const prevStreamPost = window.streamPost;
  window.streamPost = function (url, payload, handlers, abortSignal) {
    if (payload && typeof url === 'string' && url.includes('/api/chat/stream')) {
      const tutor = /gia sư/i.test(payload.systemInstruction || '');
      payload = { ...payload, systemInstruction: buildSystemPrompt(tutor) };
      if (payload.model === 'auto') {
        const lastUser = [...(payload.messages || [])].reverse().find(m => m.role === 'user');
        const text = (lastUser?.parts || []).map(p => p.text || '').join(' ');
        payload.model = pickAutoModel(text, {
          webSearch: !!payload.webSearch,
          thinking: !!payload.thinking,
          hasFiles: !!(payload.attachments && payload.attachments.length),
        });
      }
    }
    return prevStreamPost.call(this, url, payload, handlers, abortSignal);
  };

  window.updateModelPillLabel(); // cập nhật nhãn model trên ô nhập
})();
