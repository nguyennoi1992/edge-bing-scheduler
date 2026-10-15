# Báo cáo Điều tra & Khắc phục: Dashboard Reward Cards & Sự cố Mất Streak trên Profile 1 (2026-10-15)

- **Ngày:** 2026-10-15
- **Phiên bản:** 1.0.0
- **Phạm vi kiểm tra:** Google Chrome (Default profile & Profile 1), Microsoft Edge, Service Worker MV3
- **Trạng thái:** Hoàn thành fix thẻ Dashboard & xác định chính xác nguyên nhân gốc trên Profile 1

---

## 1. Khắc phục lỗi không click được thẻ Daily Set trên Dashboard

### 1.1. Hiện tượng & Log lỗi thực tế
Trên `rewards.bing.com/dashboard`, người dùng báo cáo extension không click được các thẻ trong Daily Set ("Upcoming events near me", "Trip to Chicago", "Borobudur quiz").
Trong debug logs:
- Extension mất tới 20 giây ở `waitForRewardsDomReady`.
- Section `dailyset` báo `cardRoots: 1, directRoundedAnchors: 0`.
- Cơ chế fallback `dashboard_fallback` báo reject thẻ với lý do `["not_visible", "in_nav", "no_visual"]`.
- Trang kết thúc sớm với trạng thái `stable_empty` dù các thẻ có điểm vẫn hiển thị trên màn hình.

### 1.2. Nguyên nhân kỹ thuật
1. **React Aria Disclosure & `usePress` Hook:**
   - Microsoft Rewards sử dụng React Aria Components (`data-rac=""`, `data-react-aria-pressable="true"`, `slot="trigger"`).
   - Thẻ nằm trong `.react-aria-DisclosurePanel` bị accordion thu gọn.
   - Hàm click mô phỏng chuột truyền thống không kích hoạt đủ chuỗi sự kiện mà `usePress` yêu cầu, hoặc gây ra hiện tượng duplicate click kích hoạt kép làm đóng lại disclosure.
2. **Nhiễm Hydration toàn cục (Global Anchor Pollution):**
   - Trong `waitForRewardsDomReady`, logic đếm `directRoundedAnchors` ban đầu quét trên toàn document.
   - Các liên kết điều hướng SSR ở header/footer (`/redeem`, `/about`) khiến hệ thống tưởng nhầm section `dailyset` đã hydrate xong, dẫn đến kết luận sai rằng `dailyset` rỗng (`stable_empty`).
3. **Kiểm tra Visibility chưa tương thích:**
   - Container flexbox của React Aria có thể khiến `checkVisibility` hoặc bounding rect trả về 0x0 trước khi layout ổn định.

### 1.3. Giải pháp triển khai
1. **Cơ chế Dispatch Press chuẩn hóa cho React Aria (`reward-scanner-helpers.js`):**
   - Bổ sung `global.dispatchRewardPress(el)`: Phát tuần tự chuỗi sự kiện con trỏ và chuột (`pointerdown` -> `pointerup` -> `mousedown` -> `mouseup` -> `click`) với đầy đủ tọa độ bounding box trung tâm và hủy kích hoạt duplicate native `.click()`.
   - Bổ sung `global.expandRewardSection(section)`: Tìm và mở rộng các trigger button (`button[slot='trigger'][aria-expanded='false']`, `[aria-controls]`), đồng thời trực tiếp xóa thuộc tính `hidden`, `aria-hidden="true"` và thiết lập `display: ""`, `visibility: visible` trên các panel `.react-aria-DisclosurePanel`.
2. **Khoanh vùng Hydration theo Target Sections (`background.js`):**
   - Giới hạn đếm anchor chỉ trong phạm vi các section mục tiêu (`targetSectionIds`), ngăn không cho các link ngoài trang gây hiểu lầm là section đã hoàn tất tải.
3. **Bổ sung Safe Fallback cho Helper Functions:**
   - Bọc an toàn các lệnh gọi `window.normalizeRewardText` và `window.buildRewardCardKey` để tránh `TypeError` trong môi trường script injection.

### 1.4. Kết quả kiểm chứng thực tế
- **Bộ test tự động:** 22/22 Node tests, 4/4 Edge browser tests, Extension smoke test toàn bộ PASS.
- **Test Chrome thực tế với Default Profile:**
  - Khởi chạy Google Chrome với bản clone an toàn từ profile Default.
  - Cả 3 thẻ Daily Set ("Borobudur quiz", "Events near me", "Trip to Chicago") đều được nhận diện, mở rộng accordion, click tự động và ghi nhận hoàn thành (`SUCCESS: Reward card completed or disappeared after click`).

---

## 2. Kết quả điều tra nguyên nhân Profile 1 mất Daily Set và Streak

### 2.1. Hiện tượng trên Profile 1
- Tài khoản: **Hoan Pham Van** (`country: "vn"`, Gold Member, 2,782 điểm khả dụng).
- Trong mục Thành tựu (Achievements): Tài khoản đã từng duy trì chuỗi Streak **132 ngày** liên tục (`180-day set: 132 / 180`, `365-day set: 132 / 365`, `999-day set: 132 / 999`).
- Sau mốc 132 ngày, tài khoản hoàn toàn không còn xuất hiện thẻ Daily Set trên Dashboard, và chuỗi Streak bị đứt, quay về 0.

### 2.2. Dữ liệu trích xuất từ Chrome CDP Inspection
Qua kiểm tra trực tiếp cấu trúc DOM, React Server Components và Telemetry Context trên Profile 1:

1. **A/B Experiment Flighting từ Microsoft (`telemetryContext.features`):**
   - **Profile Default:** `features: "macthemepack,bwallpaperappt1,vssctrl,qfaboutheader,enablemacbic,macnewlp"`
     - Chứa cờ `vssctrl` (**VSS Control**): Nhóm tài khoản giữ giao diện Daily Set truyền thống trên `rewards.bing.com/dashboard`.
   - **Profile 1:** `features: "macthemepack,bwallpaperappt2,vsstreak,disablemacbic,macnewlp"`
     - Chứa cờ `vsstreak` (**VSS Streak Experiment**): Nhóm tài khoản được Microsoft đưa vào thử nghiệm hệ thống Streak mới đa nền tảng (Bing Search Streak, Edge Streak, MSN Article Streak, App Streak).
     - Trong thử nghiệm `vsstreak`, Microsoft **gỡ bỏ hoàn toàn `section#dailyset` khỏi `/dashboard`**. Thay vào đó, mục quản lý Streak được chuyển sang trang `rewards.bing.com/earn` (`section#streaks`).

2. **Giới hạn phạm vi quét của Extension:**
   - Trong `background.js` (dòng 3794-3798):
     ```javascript
     if (/rewards\.bing\.com\/earn/i.test(url)) {
       targetSectionIds = ["moreactivities"];
     } else if (/rewards\.bing\.com\/dashboard/i.test(url)) {
       targetSectionIds = ["dailyset", "moreactivities"];
     }
     ```
   - Trên `/dashboard`: Extension chỉ tìm `dailyset` và `moreactivities`. Khi Microsoft gỡ `dailyset`, extension tìm thấy 0 thẻ Daily Set.
   - Trên `/earn`: Extension chỉ tìm `moreactivities` (đã hoàn thành sẵn 5/5). Extension **hoàn toàn bỏ qua** các section `streaks`, `exploreonbing`, `quests`, `levelup`.
   - **Hậu quả:** Extension không thực hiện bất kỳ hoạt động Streak nào cho tài khoản này. Sau nhiều ngày liên tiếp không có hoạt động, chuỗi Streak dừng lại ở ngày thứ 132 và bị reset.

3. **Lỗi kẹt Skeleton Loader trên `/earn`:**
   - Tại `https://rewards.bing.com/earn`, `section#streaks` bị treo ở trạng thái skeleton nhấp nháy (`animate-pulse`) và không render thẻ con.
   - Nguyên nhân: Trong bundle mã nguồn của Microsoft có đoạn:
     `"messages":{"Earn":{"Streaks":{"activateButton":"Activate streak", ... "Now you can turn on streak protection to protect your streak!"}}}`
   - Tài khoản khi chuyển sang flight `vsstreak` cần người dùng thao tác thủ công một lần để "Kích hoạt Streak" (Activate streak / Streak Protection) trên web hoặc ứng dụng Bing. Do chưa được kích hoạt, API trả về Suspense fallback vô tận.

---

## 3. Khuyến nghị cho người dùng
1. **Kích hoạt Streak thủ công trên Profile 1:**
   - Mở Chrome với Profile 1, truy cập trực tiếp vào [rewards.bing.com/earn](https://rewards.bing.com/earn).
   - Kiểm tra thông báo kích hoạt chuỗi hoặc bật tính năng **Streak Protection** để đưa tài khoản thoát khỏi trạng thái skeleton loader.
2. **Khôi phục Streak qua Microsoft Rewards Support (nếu cần):**
   - Người dùng có thể gửi ticket hỗ trợ tới Microsoft Rewards Support báo cáo sự cố chuyển đổi giao diện `vsstreak` khiến chuỗi 132 ngày bị gián đoạn; Microsoft thường hỗ trợ khôi phục Streak (Streak Restoration) 1 lần cho người dùng đạt chuỗi dài.
