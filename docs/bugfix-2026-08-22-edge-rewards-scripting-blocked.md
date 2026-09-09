# Bugfix: Lỗi "The extensions gallery cannot be scripted" trên Microsoft Edge

- **Ngày:** 2026-08-22
- **Phiên bản extension:** 1.0.0
- **Mức độ:** Medium (Rewards phase thất bại trên Edge, search phase vẫn chạy bình thường)
- **Trạng thái:** ✅ Đã fix — toàn bộ test pass

---

## 1. Hiện tượng (Symptom)

Trên **Microsoft Edge**, khi chạy automation (Run Now hoặc lịch định kỳ), phase Rewards luôn thất bại với 2 URL `rewards.bing.com/earn` và `rewards.bing.com/dashboard`. Trên **Chrome**, extension chạy bình thường.

Log export từ extension (thư mục `logs/`, ngày 21/08/2026):

```
21/08/2026 11:06:33 | REWARDS | Processing reward URL | url=https://rewards.bing.com/earn
21/08/2026 11:06:42 | REWARDS | Closed reward parent tab | tabId=419727896 | url=https://rewards.bing.com/earn
21/08/2026 11:06:42 | REWARDS | Reward URL failed | error=Error: The extensions gallery cannot be scripted. | url=https://rewards.bing.com/earn
21/08/2026 11:06:55 | REWARDS | Reward URL failed | error=Error: The extensions gallery cannot be scripted. | url=https://rewards.bing.com/dashboard
21/08/2026 11:06:55 | REWARDS | Rewards phase completed with incomplete URL(s) | outcomes=[... status:"incomplete" ...]
```

Điểm đáng chú ý trong log:

- `ensureTabLoaded` thành công, tab load xong bình thường, host đúng `rewards.bing.com` → không phải lỗi mạng/redirect.
- Tab mở được ~5 giây rồi bị đóng ngay tại bước inject script.
- Search phase phía sau vẫn chạy tốt (các tab `www.bing.com` script được bình thường).

## 2. Nguyên nhân gốc (Root Cause)

Lỗi `The extensions gallery cannot be scripted.` là thông báo của Chromium khi extension gọi `chrome.scripting.executeScript()` vào trang thuộc danh mục bị bảo vệ (webstore/addons gallery).

**Microsoft Edge tái sử dụng cơ chế này để chặn scripting vào các trang first-party của chính Microsoft**, bao gồm `rewards.bing.com`. Đây là hành vi đã biết của Edge (tương tự case `edgeservices.bing.com/chat` và `copilot.microsoft.com` trong issue [microsoft/MicrosoftEdge-Extensions#156](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/156) — không content script nào chạy được trên các domain đó).

Chuỗi sự kiện trên Edge:

1. `chrome.tabs.create({url: "https://rewards.bing.com/earn"})` → tab mở và load thành công.
2. `inspectLoadedTab()` probe bằng `executeScript` cũng fail nhưng nằm trong `try/catch` nên bị nuốt âm thầm → validation vẫn pass nhờ `tab.status === "complete"` (giải thích vì sao log không có warning navigation).
3. `injectDomHelpers(tab.id)` → `executeScript({world: "MAIN"})` → **Edge chặn ở tầng browser** và throw `The extensions gallery cannot be scripted.`
4. Exception không được bắt → bay lên catch ở vòng lặp reward URLs → outcome `incomplete / error`.

Chrome không có restriction này với `rewards.bing.com` nên không bao giờ gặp lỗi.

## 3. Giải pháp (Fix)

> Không thể "vá" lỗi từ phía extension vì đây là rào cản bảo mật tầng browser của Edge. Fix hướng đến: phát hiện đúng lỗi này, xử lý sạch sẽ, log rõ nguyên nhân, và không ảnh hưởng Chrome.

Thay đổi trong `background.js`:

### 3.1. Thêm 2 helper (ngay trên `autoClickRewards`)

```js
function getBrowserName() {
  const ua = globalThis.navigator?.userAgent || "";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Chrome\//.test(ua)) return "chrome";
  return "unknown";
}

function isProtectedPageScriptError(error) {
  const message = String(error?.message || error || "");
  return /extensions gallery cannot be scripted/i.test(message);
}
```

### 3.2. Bắt lỗi ngay tại bước inject trong `processRewardUrl`

Nếu Edge chặn → skip sạch sẽ URL đó với reason `page_scripting_blocked`, log mức **warn** (không còn error đỏ), tab vẫn được dọn qua khối `finally` như cũ:

```js
try {
  await injectDomHelpers(tab.id);
} catch (e) {
  if (!isProtectedPageScriptError(e)) throw e;
  await appendDebugLog("warn", "rewards",
    "Browser protects this page from extension scripting; rewards automation skipped",
    { url, browser: getBrowserName(), reason: "page_scripting_blocked" });
  return { status: "incomplete", reason: "page_scripting_blocked", elapsedMs: ... };
}
```

### 3.3. Safety net ở vòng lặp reward URLs

Catch ngoài phân loại thêm trường hợp này (phòng khi lỗi nổ ở các lời gọi `executeScript` khác giữa chừng): log chuyển sang warn với message riêng, outcome ghi `reason: "page_scripting_blocked"` thay vì `error`.

### 3.4. Thiết kế chủ động giữ nguyên bước thử inject

Code vẫn thử inject trước khi skip → nếu sau này Microsoft bỏ chặn `rewards.bing.com` trên Edge thì tính năng tự hoạt động lại mà không cần sửa code. Chi phí chỉ ~5s mỗi URL khi bị chặn.

## 4. Hành vi sau fix

| Browser | Rewards phase | Search phase |
|---|---|---|
| Chrome | Như cũ (hoạt động đầy đủ) | Như cũ |
| Edge | Skip có kiểm soát, log warn `page_scripting_blocked` + tên browser | Chạy bình thường |

Log mẫu sau fix (dự kiến):

```
REWARDS | Browser protects this page from extension scripting; rewards automation skipped | url=... | browser=edge | reason=page_scripting_blocked
```

## 5. Kiểm chứng (Verification)

```bash
node --check background.js        # PASS
bash tests/run-all-tests.sh       # PASS toàn bộ:
# - 16/16 Node tests (reward-dom-helpers, rewards-scanning, script-result-helpers)
# - JavaScript syntax check
# - Manifest & shell scripts check
# - Microsoft Edge browser tests (earn card scanning, delayed hydration, dashboard scanning)
# - Extension loads in Edge with service worker OK
```

## 6. Hạn chế đã biết

- Trên Edge, auto-click Rewards **không thể hoạt động** cho tới khi Microsoft gỡ rào chặn ở tầng browser (extension không có cách nào vượt qua một cách hợp lệ).
- Nếu muốn Rewards tự động trên Edge, có thể cân nhắc hướng thay thế trong tương lai: chạy profile Rewards trên Chrome, hoặc theo dõi việc Edge mở khóa scripting cho `rewards.bing.com`.
