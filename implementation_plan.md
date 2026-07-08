# Kế hoạch sửa lỗi: Hỗ trợ Quiz hội thoại (Copilot) bằng quét shadow DOM

> Phạm vi: kế hoạch này chỉ xử lý lỗi **child tab quiz/Copilot Conversational Quiz**. Nó không phải kế hoạch cho lỗi Daily Set `/dashboard` chỉ click được 1 card; phần `/dashboard` đã được xử lý bằng cơ chế chờ Rewards DOM ready và re-scan từng card trong `background.js`.

## Vấn đề hiện tại
Nhiều nhiệm vụ Bing Rewards hiện nay là **Conversational Quiz** (Quiz hội thoại chạy trong giao diện Copilot, có tham số `IsConversation: "True"` trên URL).
- Giao diện Copilot hiển thị các nút trả lời câu hỏi bên trong **shadow DOM** của các Web Components (VD: `cib-serp`, `cib-conversation`, `cib-choice`...).
- Hàm `buildCandidates()` trong trình giải Quiz hiện tại của extension (`handleRewardChildTab()` trong [background.js](/u01/tools/edge-bing-scheduler/background.js)) chỉ dùng `document.querySelectorAll()`. Hàm này **không thể truy cập vào shadow DOM**, dẫn đến việc không tìm thấy các nút câu trả lời của Copilot. Trình giải Quiz có thể không tìm thấy candidate, hoặc click nhầm các nút điều hướng bên ngoài cho tới khi thất bại với trạng thái `no_progress`.
- Repo đã có một mẫu xử lý đúng ở phần claim điểm: `collectAllElements(document)` quét đệ quy cả `shadowRoot`. Ta nên tái dùng cùng hướng tiếp cận cho quiz solver.

---

## Giải pháp đề xuất

### 1. Thêm hàm tìm kiếm đệ quy shadow DOM vào trình giải Quiz
Chúng ta sẽ bổ sung hàm `collectAllElements` vào phạm vi injected script của `handleRewardChildTab` để duyệt qua toàn bộ cây DOM, bao gồm cả các `shadowRoot` mở.

### 2. Cập nhật `buildCandidates` để dùng hàm này
Thay vì gọi `document.querySelectorAll()`, ta sẽ quét tất cả phần tử thu thập được từ `collectAllElements(document)` và lọc ra các ứng viên nút bấm.

### 3. Thêm scoring riêng cho Copilot Web Components
Ưu tiên các element hoặc ancestor bên trong `cib-choice`, `cib-shared`, hoặc tag name có chứa `choice`. Lưu ý: `el.closest(...)` không luôn leo xuyên qua shadow boundary tới host bên ngoài, nên scoring không nên phụ thuộc hoàn toàn vào ancestor ngoài shadow DOM.

### 4. Thêm diagnostic khi quiz không hoàn thành
Khi quiz fail `no_progress`, log thêm URL, `isConversation`, số candidate và top candidates để lần sau biết rõ là không thấy nút hay thấy nhưng click sai.

---

## Chi Tiết Thay Đổi

### [Component] Quiz Solver ([background.js](file:///u01/tools/edge-bing-scheduler/background.js))

#### [MODIFY] `handleRewardChildTab()` trong [background.js](/u01/tools/edge-bing-scheduler/background.js)

Chúng ta sẽ định nghĩa `collectAllElements` bên trong `handleRewardChildTab` và dùng nó để tìm kiếm các nút bấm.

```javascript
            const collectAllElements = (root) => {
              const results = [];
              const visit = (node) => {
                if (!node) return;
                if (node.nodeType === Node.ELEMENT_NODE) {
                  results.push(node);
                  if (node.shadowRoot) {
                    visit(node.shadowRoot);
                  }
                }
                const children = node.children || [];
                for (const child of children) {
                  visit(child);
                }
              };
              visit(root || document);
              return results;
            };

            const getCandidateText = (el) =>
              normalizeText(
                el.innerText || el.textContent || el.getAttribute("aria-label") || el.value || "",
              );

            const buildCandidates = () => {
              const allElements = collectAllElements(document);
              return allElements
                .filter((el) => el instanceof HTMLElement)
                .filter((el) => {
                  // Khớp với các nút bấm tiêu chuẩn hoặc các thẻ tùy chỉnh dạng option/choice của Copilot
                  return el.matches("button, [role='button'], a[href], input[type='button'], input[type='submit'], label, [data-tag], [class*='option'], [class*='Option'], [class*='answer'], [class*='Answer'], [class*='choice'], [class*='Choice']") ||
                         /choice/i.test(el.tagName);
                })
                .filter((el) => isVisible(el) && !isDisabled(el))
                .map((el) => {
                  const text = getCandidateText(el);
                  let score = 0;
                  if (!text || text.length > 120) score -= 100;
                  if (/(^sign in$|^feedback$|^privacy$|^terms$|^rewards$|^search$|^images$|^videos$|^maps$|^news$|^all$|^back$|^more$|^menu$|^settings$|^share$|^copy$|^chat$)/i.test(text)) {
                    score -= 100;
                  }
                  if (el.closest("nav, header, footer, [role='navigation'], [role='banner'], [role='contentinfo']")) {
                    score -= 80;
                  }
                  if (el.matches("button, [role='button'], input[type='button'], input[type='submit']")) {
                    score += 40;
                  }
                  if (el.closest("main, [role='main'], form, [class*='quiz'], [id*='quiz'], [class*='Quiz']")) {
                    score += 20;
                  }
                  if (text.length > 0 && text.length <= 80) score += 10;
                  if (/answer|option|choice|true|false|yes|no/i.test(text)) score += 15;
                  if (/start|play|begin|continue|next|submit|check answer|see results?|take the quiz|let's go/i.test(text)) score += 35;
                  if (el.closest(".btOption, .wk_option, .geSlide, #rc-poll-container, .poll-container")) score += 30;
                  if (el.matches("[data-tag], [class*='option'], [class*='Option']")) score += 25;
                  if (el.closest("[class*='BingQA'], [class*='quiz-container'], [id*='quiz-container'], [class*='trivia']")) score += 30;
                  if (/^\s*[A-Da-d1-4][.)\s]/i.test(text)) score += 20;
                  
                  // Tăng điểm cho các nút lựa chọn bên trong Copilot Chat
                  if (el.tagName.toLowerCase().includes("choice") || el.closest("cib-choice, cib-shared")) {
                    score += 50;
                  }
                  return { el, text, score };
                })
                .filter((item) => item.score > 0)
                .sort((a, b) => b.score - a.score);
            };
```

#### [MODIFY] Thêm diagnostic vào kết quả quiz solver

Trong vòng lặp quiz, lưu lại snapshot candidate gần nhất để trả về/log khi hết 25 attempts:

```javascript
            let lastCandidateSnapshot = [];
            for (let attempt = 0; attempt < 25; attempt++) {
              if (isQuizCompleted()) {
                return { handled: true, completed: true, clicks, reason: "completed" };
              }

              const candidates = buildCandidates();
              lastCandidateSnapshot = candidates.slice(0, 8).map((item) => ({
                text: item.text.substring(0, 100),
                score: item.score,
                tag: item.el.tagName,
              }));

              // existing click logic...
            }

            return {
              handled: true,
              completed: isQuizCompleted(),
              clicks,
              reason: isQuizCompleted() ? "completed" : "no_progress",
              diagnostics: {
                url: location.href,
                isConversation: /isconversation/i.test(location.href),
                candidates: lastCandidateSnapshot,
              },
            };
```

Ở caller sau `handleRewardChildTab(childTabId)`, ghi `diagnostics` vào `appendDebugLog` cùng log hiện có `Handled reward quiz child tab`.

---

## Kế hoạch kiểm thử & Xác minh

1. **Kiểm tra cú pháp**: chạy `node --check` với bản copy `.mjs` của `background.js`.
2. **Kiểm tra whitespace**: chạy `git diff --check`.
3. **Reload extension**: reload lại extension trên Edge để service worker nhận code mới.
4. **Thử nghiệm chạy**: dùng một nhiệm vụ có URL chứa `IsConversation` hoặc một Conversational Quiz trong Copilot.
5. **Đọc log**: xác nhận `handleRewardChildTab` có `handled=true`, `completed=true` hoặc nếu fail thì log có `diagnostics.candidates`.

## Rủi ro & lưu ý

- Chỉ quét được **open shadow roots**. Nếu Bing/Copilot dùng closed shadow root thì extension không thể đọc trực tiếp bằng `shadowRoot`.
- Candidate scoring vẫn là heuristic; cần log top candidates để tinh chỉnh theo DOM thực tế.
- Không nên mở rộng selector quá rộng mà thiếu scoring, vì dễ click nhầm navigation hoặc nút UI Copilot không phải câu trả lời.
