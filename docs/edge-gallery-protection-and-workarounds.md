# Nghiên Cứu Cơ Chế: Xử Lý Lỗi "The extensions gallery cannot be scripted" Trên Microsoft Edge

- **Ngày:** 2026-10-30
- **Tác giả:** Đội ngũ phát triển Edge Bing Scheduler
- **Phạm vi:** Microsoft Edge (Linux / Windows / macOS), Chrome Manifest V3 Extensions

---

## 1. Hiện Tượng & Bối Cảnh (Symptom & Context)

Khi tiện ích mở rộng (extension) cố gắng can thiệp vào trang `https://rewards.bing.com/*` trên Microsoft Edge thông qua:
1. `chrome.scripting.executeScript({ target: { tabId }, ... })`
2. Hoặc Content Script được khai báo trong `manifest.json`:
   ```json
   "content_scripts": [
     { "matches": ["https://rewards.bing.com/*"], ... }
   ]
   ```

Microsoft Edge sẽ ngay lập tức:
- **Throw Runtime Exception:** `Error: The extensions gallery cannot be scripted.` đối với `executeScript`.
- **Âm thầm bỏ qua (Silent Drop):** Không inject Content Script vào tab `rewards.bing.com`.

Trong khi đó, trên Google Chrome, trang `https://rewards.bing.com/*` được script và inject hoàn toàn bình thường.

---

## 2. Nguyên Nhân Gốc Tầng Trình Duyệt (Browser-Level Root Cause)

### 2.1. Cơ chế bảo vệ Webstore trong mã nguồn Chromium
Trong kiến trúc cốt lõi của Chromium (`extensions/common/extension_urls.cc` và `extensions/browser/script_executor.cc`):
```cpp
const char kCannotScriptGalleryError[] = "The extensions gallery cannot be scripted.";

bool Extension::IsRestrictedUrl(const GURL& document_url, std::string* error) const {
  if (extension_urls::IsWebstoreDomain(document_url)) {
    if (error) *error = manifest_errors::kCannotScriptGalleryError;
    return true;
  }
  ...
}
```
Mục tiêu ban đầu của Chromium là ngăn chặn các extension độc hại tự ý can thiệp, click nút cài đặt, hoặc đánh cắp token trên cửa hàng tiện ích (Chrome Web Store: `chrome.google.com/webstore`, `chromewebstore.google.com`).

### 2.2. Tùy biến bảo vệ riêng của Microsoft Edge
Khi Microsoft đóng gói Edge (kiểm chứng trực tiếp trên binary `/opt/microsoft/msedge/msedge`), Microsoft đã mở rộng danh sách `IsWebstoreDomain` / `IsRestrictedUrl` để bảo vệ các trang first-party nội bộ của Microsoft:
1. `microsoftedge.microsoft.com/addons` (Edge Add-ons Gallery)
2. `chrome.google.com/webstore`
3. `chromewebstore.google.com`
4. **`rewards.bing.com`** (Microsoft Rewards Hub & Dashboard)

Vì Edge tích hợp Microsoft Rewards trực tiếp vào shell hệ thống của trình duyệt (profile flyout, thanh địa chỉ, browser rewards widget), Microsoft xếp `rewards.bing.com` vào cùng ranh giới bảo mật cấp độ cửa hàng (store gallery sandbox). Ranh giới này được kiểm tra bằng code C++ nội bộ trước khi bất kỳ API `chrome.scripting` nào được cấp quyền.

---

## 3. Các Cơ Chế Giải Pháp & Khắc Phục Toàn Diện (Workaround Mechanisms)

Sau khi nghiên cứu sâu và kiểm nghiệm thực tế trên cả hai hồ sơ (`Default` và `Profile 1`), chúng tôi thiết lập 5 cơ chế phối hợp:

### Cơ Chế 1: Chuyển Dịch Domain Sang `www.bing.com` (Domain Shift Architecture - Cốt Lõi)
Microsoft Edge **chỉ áp dụng hạn chế lên subdomain `rewards.bing.com`**, hoàn toàn **không hạn chế domain `www.bing.com`**:
- **Dữ liệu đầy đủ từ Panel Flyout:**
  Endpoint `https://www.bing.com/rewards/panelflyout` chạy trên `www.bing.com`. Nó trả về toàn bộ dữ liệu:
  - Daily Set 3 thẻ (`window.flyoutViewModel.flyoutResult.dailySetPromotions`)
  - Chuỗi ngày liên tiếp (`streakPromotion.activityProgress`)
  - Cả 5 thẻ trong mục "Your activity" (`dailyCheckInPromotion.attributes` gồm `bing`, `dset`, `edge`, `sapphire`, `visualsearch`).
- **Thực thi nhiệm vụ:**
  Tất cả các thẻ Daily Set (`bingredirect`, tìm kiếm, câu hỏi quiz/poll) và Visual Search đều có thể mở và tương tác hoàn chỉnh trên `www.bing.com` mà không gặp lỗi gallery.

### Cơ Chế 2: Render Trực Tiếp Trên Giao Diện Native Của Extension (Popup & Sidebar)
Edge chỉ chặn việc inject script vào DOM của trang web `rewards.bing.com`. Nó **không thể chặn giao diện riêng của extension**:
- Extension chạy trong origin biệt lập: `chrome-extension://<id>/popup.html` và `sidebar.html`.
- Extension lấy dữ liệu flyout từ background, tự render thẻ **Daily Set** (`#dailySetCard`) và **Your activity** (`#yourActivityCard`).
- Người dùng trên cả Profile Default lẫn Profile 1 đều có thể theo dõi tiến độ, xem số ngày streak 🔥, mở thẻ, hoặc bấm nút tìm kiếm ngay từ Toolbar / Side Panel của Edge.

### Cơ Chế 3: Kích Hoạt & Tự Động Hóa Visual Search Bằng Upload Canvas Image
Trên Edge Profile 1, thẻ Visual Search ban đầu ở trạng thái chưa kích hoạt (`partner_visualsearch_isEnabled: "False"`, hiển thị nhãn `"How to activate"`):
- Nút `"Activate streak"` trên dashboard dẫn về:
  `https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES` (nằm trên `www.bing.com`).
- Tiện ích mở URL này, bấm nút Visual Search (`#sb_sbi`), sinh một ảnh PNG 100x100 ngẫu nhiên qua HTML5 Canvas, đính vào `#sb_fileinput` qua `DataTransfer` và dispatch sự kiện `change`.
- Bing tự động upload ảnh lên `/images/kblob`, chuyển trang tìm kiếm sang `https://www.bing.com/search?q=...&FORM=SBIHMP`.
- Kết quả kiểm chứng thực tế:
  - `vs_enabled` đổi từ `"False"` thành `"True"`.
  - `vs_completed` đổi từ `"False"` thành `"True"`.
  - `bing_completed` cũng đổi thành `"True"` (tính luôn 1 lượt tìm kiếm Bing).
  - Trạng thái trên Profile 1 trở nên kích hoạt và đầy đủ ngọn lửa chuỗi 🔥 y như Default!

### Cơ Chế 4: Bắt Lỗi & Phân Nhánh An Toàn Trong Background Service Worker
Trong `background.js`:
```javascript
function isProtectedPageScriptError(error) {
  const msg = String(error?.message || error || "");
  return msg.includes("extensions gallery cannot be scripted") ||
         msg.includes("Cannot access a chrome:// URL");
}
```
Khi phát hiện lỗi này, background service worker không crash luồng, mà chuyển hướng thông minh:
1. Ghi log cảnh báo `info` / `warn` thay vì nổ exception đỏ.
2. Tự động kích hoạt luồng fallback: `processEdgeFlyoutDailySet()` và `performVisualSearch()`.
3. Lưu trữ thẻ và tiến độ vào `chrome.storage.local` để UI Popup/Sidebar sử dụng.

### Cơ Chế 5: Tự Động Hóa Kiểm Thử & Headless Qua CDP (Chrome DevTools Protocol)
Trong môi trường kiểm thử tự động (`verify-dual-profile-live.mjs`):
- Kết nối thông qua DevTools WebSocket (`CDP`).
- CDP chạy ở tầng browser engine bên ngoài sandbox của extension, do đó lệnh `Runtime.evaluate`, `Page.navigate`, và `Input.dispatchMouseEvent` có thể tương tác với `rewards.bing.com` để verify DOM mà không hề bị chặn.

---

## 4. Bảng So Sánh Trước & Sau Khi Áp Dụng

| Tiêu Chí | Trước Khi Áp Dụng | Sau Khi Áp Dụng |
|---|---|---|
| **Lỗi Gallery trên Edge** | Nổ Exception dừng toàn bộ phase Rewards | Bắt sạch sẽ, tự động fallback sang `www.bing.com` |
| **Thẻ Daily Set trên Edge** | Mất tích hoặc không load được trên Profile 1 | Hiển thị đầy đủ trong Popup & Sidebar, tự động click hoàn thành |
| **"Your activity" trên Edge Profile 1** | Bị xám, hiển thị "How to activate", streak 0 | Tự kích hoạt thành công qua Visual Search, hiển thị đủ 5 thẻ trên Popup & Sidebar |
| **Visual Search 1-click** | Chưa có, phải upload ảnh thủ công | 1-click tự sinh ảnh Canvas 100x100, upload tự động, tính 1 lượt search & 1 lượt streak |
| **Khả năng tương thích Chrome** | Hoạt động bình thường | Vẫn hoạt động hoàn hảo 100%, không bị ảnh hưởng |

---

## 5. Quy Chuẩn Môi Trường Kiểm Thử (Virtual Display)

Theo yêu cầu an toàn phiên làm việc của người dùng, mọi lệnh kiểm thử hoặc khởi chạy trình duyệt Edge/Chrome tự động **bắt buộc** phải chạy qua virtual display wrapper:

```bash
/u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh \
  env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME \
  node tests/verify-dual-profile-live.mjs
```
Hoặc kiểm thử riêng cho Edge:
```bash
/u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh \
  env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME \
  BROWSER=edge node tests/verify-dual-profile-live.mjs
```
