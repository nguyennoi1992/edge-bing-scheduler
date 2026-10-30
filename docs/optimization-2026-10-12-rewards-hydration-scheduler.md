# Tối ưu hóa hiệu năng và độ ổn định dựa trên Debug Logs (2026-10-12)

- **Ngày:** 2026-10-12
- **Phiên bản extension:** 1.0.0
- **Phạm vi:** Rewards automation, Scheduler, Logging, Child tab cleanup
- **Mục tiêu:** Rút ngắn thời gian chạy, khắc phục vòng lặp reload 8 phút trên trang Rewards đã hoàn thành, đảm bảo an toàn tuyệt đối cho thao tác click card trên Chrome, giảm dung lượng log.

---

## 1. Bối cảnh & Hiện trạng phân tích từ Debug Logs

Từ các file debug log mới nhất thu thập ngày 12/10/2026 trên cả 4 profile (Chrome và Microsoft Edge):
- `abc40197@gmail.com` (Chrome)
- `tinkinhte.k56.humg@gmail.com` (Chrome)
- `nguyennoi1992` (Edge)
- `tinkinhtek56.humg@gmail.com` (Edge)

Đã phát hiện 5 điểm nghẽn và vấn đề cần tối ưu:

### 1.1. Lãng phí 16 - 24 phút do vòng lặp reload "Hydration Timeout" khi trang đã hoàn thành
- **Hiện tượng:** Trên Chrome (`abc40197`, `tinkinhte.k56`), sau khi hoàn thành Quest/Punchcard, trang `rewards.bing.com/earn` và `rewards.bing.com/dashboard` không còn card nào chưa làm (`cards: 0`). Tuy nhiên extension liên tục báo `hydrationStatus=header_only` hoặc `hydrating`, kích hoạt cơ chế `Reward section hydration recovery` reload tab 8 - 9 lần và chờ tối đa `REWARD_URL_TIMEOUT_MS` = 480,000ms (8 phút) cho mỗi URL.
- **Nguyên nhân gốc:** Thuộc tính `sectionDebug.hydrated` trong `background.js` trước đây chỉ được gán `true` khi `cardShells > 0` (chỉ tính card chưa hoàn thành, hiển thị rõ). Khi người dùng đã làm xong hết các hoạt động trong ngày, `completedCount > 0` và `directRoundedAnchors > 0` nhưng `cardShells === 0`, dẫn tới trang bị coi là "chưa hydrate xong". Extension reload lặp đi lặp lại 8 phút dù DOM đã render xong từ lâu.
- **Tác động:** Một lượt chạy bị kéo dài từ ~1 giờ lên tới 1 giờ 43 phút.

### 1.2. Thẻ hoạt động trên Dashboard bị ẩn do Accordion đóng
- **Hiện tượng:** Trong log của `abc40197`, các thẻ có điểm như `Trip to San Francisco (+10)` và `Ha Long Bay quiz (+10)` xuất hiện trong DOM nhưng bị reject với lý do `["not_visible"]`.
- **Nguyên nhân gốc:** Thẻ nằm trong khối accordion/disclosure của giao diện mới, nhưng hàm `collectPageRewardFallbackCards` không gọi `expandSectionIfCollapsed(document)`, khiến các thẻ có `display: none` hoặc kích thước 0x0.

### 1.3. Polling child tab dư thừa và pass Rewards thứ 2 trên Edge khi bị chặn script
- **Hiện tượng:** Trên Edge (`nguyennoi1992`), browser chặn script bằng cơ chế `page_scripting_blocked`. Dù không có tab con nào được sinh ra và không có click nào xảy ra, khối `finally` vẫn chạy 4 round `closeChildTabs` với độ trễ 1200ms mỗi round (mất ~5s mỗi URL). Sau đó, pass thứ 2 sau Search phase vẫn mở lại Rewards và bị chặn tiếp.

### 1.4. Bão alarm và log trùng lặp khi mất kết nối Internet kéo dài
- **Hiện tượng:** Trong sự cố mất mạng từ 01:00 đến 06:44 sáng 12/10/2026 trên `tinkinhte.k56`, log ghi nhận 231 lần liên tục ghi `SCHEDULER | Next run scheduled` và `INTERNET | Internet unavailable; retry scheduled`.
- **Nguyên nhân gốc:** Mỗi khi service worker MV3 thức dậy để xử lý alarm `internetRetry` (mỗi 1 phút), dòng lệnh `scheduleAlarm()` ở top-level của `background.js` luôn được gọi lại vô điều kiện, xóa alarm cũ, tạo lại alarm mới và ghi debug log trùng lặp dù thời gian hẹn giờ không hề thay đổi.

### 1.5. Phình to kích thước Debug Log (gần 1 MB mỗi profile)
- **Hiện tượng:** File log của profile đạt tới 895 KB chỉ sau vài ngày, một số dòng log dài hơn 7,000 ký tự.
- **Nguyên nhân gốc:** Lệnh ghi log `Reward card scan diagnostics` serialize toàn bộ mảng DOM metadata chi tiết của từng phần tử bị reject (bao gồm href dài, thuộc tính text, flags) vào storage.

---

## 2. Các giải pháp tối ưu đã triển khai

### 2.1. Chuẩn hóa nhận diện Hydration & Hoàn thành trang sạch sẽ
- **Nhận diện Hydration chính xác:**
  - Trong `collectSectionCardsById` và `collectPageRewardFallbackCards`, cập nhật:
    `sectionDebug.hydrated = sectionDebug.cardShells > 0 || sectionDebug.completed > 0 || sectionDebug.directRoundedAnchors > 0;`
  - Trong `waitForRewardsDomReady`, nhận diện hydration nếu có `directRoundedAnchors > 0` hoặc `hydratedCards > 0`.
  - Trong `reward-dom-helpers.js`, hàm `classifyRewardScanState` không coi section là `header_only` nếu đã có `completed > 0`.
- **Hoàn thành ngay khi hết card:**
  - Trong vòng lặp scan, nếu `rewardCards.length === 0` và trang đã có thẻ hoàn thành hoặc anchor thẻ (`completedCount > 0 || anchorCount > 0`), extension kết thúc URL ngay lập tức với trạng thái `completed (stable_empty)`.
- **Giới hạn an toàn:**
  - Giảm trần `REWARD_URL_TIMEOUT_MS` từ 480,000ms (8 phút) xuống 240,000ms (4 phút).
  - Giới hạn tối đa 3 lần reload hydration liên tiếp (`consecutiveHydrationRetries > 3`) thay vì lặp vô tận.

### 2.2. Tự động mở rộng Accordion/Disclosure trên Dashboard Fallback
- Thêm lời gọi `expandSectionIfCollapsed(document)` vào `collectPageRewardFallbackCards` trong cả 2 bước scan (`getRewardCards`, `waitForRewardsDomReady`) và click (`clickRewardCard`).
- Giúp các thẻ Rewards nằm trong các section đóng tự động mở ra, hiển thị đầy đủ để extension click nhận điểm.

### 2.3. Tối ưu dọn dẹp Tab con và Bỏ qua Pass 2 trên Edge
- Trong khối `finally` của `processRewardUrl`, chỉ thực hiện polling 4 round với delay nếu thực sự có tab con sinh ra hoặc đã click card (`spawnedTabIds.length > 0 || clickCount > 0`). Nếu không có thao tác nào (như khi bị Edge chặn), chuyển sang kiểm tra nhanh 1 round không delay (`delayMs = 0`), tiết kiệm ngay ~10 giây mỗi lượt.
- Trong `runTask`, nếu toàn bộ URL ở pass 1 đều bị `page_scripting_blocked` bởi policy của browser, extension sẽ log ghi chú và bỏ qua pass 2 (vì pass 2 chắc chắn cũng sẽ bị chặn), tiết kiệm thêm ~20 - 30 giây và không mở tab thừa.

### 2.4. Deduplicate Alarm & Loại bỏ Scheduler Log Spam
- Trong `scheduleAlarm`, kiểm tra alarm hiện tại bằng `chrome.alarms.get(ALARM_NAME)`. Nếu alarm đã được đặt trùng khớp với thời gian dự kiến (`Math.abs(scheduledTime - nextTime) < 1000`) và không có yêu cầu reset (`!clearDelayed`), bỏ qua bước recreate alarm và không ghi log trùng lặp.
- Ngăn chặn hoàn toàn hiện tượng ghi hàng trăm log giống nhau khi service worker thức dậy định kỳ.

### 2.5. Rút gọn cấu trúc Diagnostic Log
- Chuyển đổi dữ liệu `sections` trong log `Reward card scan diagnostics` sang dạng `compactSections` (chỉ lưu các chỉ số thống kê tổng hợp: `cardRoots`, `accepted`, `completed`, `directRoundedAnchors`, `rejectionReasons` rút gọn, `filteredOutCount`).
- Giảm dung lượng mỗi dòng log từ ~7,000 bytes xuống ~200 bytes (tiết kiệm hơn 97% dung lượng lưu trữ trong `chrome.storage.local`).

---

## 3. Đảm bảo an toàn cho Chrome (Zero Regression)

- **Cơ chế click card không bị thay đổi:** Khi có thẻ hợp lệ chưa hoàn thành (`cardsCount > 0`), trạng thái trả về là `ready_cards` và hàm `clickRewardCard` được gọi chính xác như trước.
- **Tăng tỷ lệ click thành công:** Nhờ việc mở rộng accordion trên document, các thẻ trước đây bị ẩn (`not_visible`) trên Dashboard nay sẽ được phát hiện và click bình thường.
- **Toàn bộ logic bảo vệ Edge:** Chỉ áp dụng rẽ nhánh riêng khi có cờ `page_scripting_blocked` hoặc tên browser là Edge, không can thiệp vào luồng xử lý của Chrome.

---

## 4. Kết quả kiểm thử (Verification)

Toàn bộ test suite được thực thi và vượt qua 100%:
1. **Node.js Unit Tests:** 17/17 tests PASS (bao gồm các test bổ sung cho `classifyRewardScanState` với completed sections).
2. **JavaScript Syntax Check:** PASS trên toàn bộ các file (`background.js`, `popup.js`, `options.js`, `sidebar.js`, `reward-dom-helpers.js`, `reward-scanner-helpers.js`, `script-result-helpers.js`, `words.js`).
3. **Manifest & Shell Scripts Check:** PASS.
4. **Microsoft Edge Headless Tests:**
   - PASS: `earn card scanning`
   - PASS: `earn delayed hydration`
   - PASS: `dashboard card scanning`
5. **Extension Smoke Test:** PASS (Service worker nfhfoeifnelcgcalhnbidjdmgohcfbon nạp thành công).
