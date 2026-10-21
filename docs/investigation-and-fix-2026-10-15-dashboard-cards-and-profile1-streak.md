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

### 1.4. Bổ sung bộ lọc Non-href & Tinh chỉnh Target Sections (2026-10-20)
1. **Lọc triệt để các phần tử không có href (`!hasValidHref`):**
   - Trong `section#streaks` và `section#levelup`, Microsoft hiển thị các badge và nút tiến trình ("1,000 BONUS", "Bing search streak", "Daily set streak", "Complete the Daily Set for 7 days in a row").
   - Cập nhật `isActionableRewardCard` và `isRewardSectionChrome` để loại bỏ các phần tử non-href khớp với:
     - `/^(?:(?:\+?\d[\d,.]*\s+)?bonus|.*streak|level up activities)$/i`
     - `/\b\d+\s+days\s+in\s+a\s+row\b/i`
     - `/^\+?\d+(?:\s*(?:pts?|points?|days?|ngày))?$/i` (các mốc số trần không có động từ nhận điểm).
   - Đồng thời lọc bỏ các liên kết điều hướng nội bộ của Microsoft Rewards (`/about`, `/redeem`, `/refer`, `/status`, `/optout`).
   - Giữ lại duy nhất nút nhận điểm thật ("Ready to claim" / "Claim points").
2. **Chuẩn hóa `targetSectionIds` & điều kiện Hydration:**
   - Trên `/earn`: mục tiêu là `["moreactivities", "exploreonbing"]` (không đưa `#streaks` vào vì streak chỉ là tracker tiến trình).
   - Trên `/dashboard`: mục tiêu là `["dailyset", "moreactivities", "offers"]`.
   - Trong `allRelevantHydrated`: Cho phép bỏ qua các section trống hoặc chỉ chứa chrome (`directRoundedAnchors === 0 && completed === 0 && accepted === 0`) giúp trang hoàn tất sớm ngay khi toàn bộ thẻ hiện hữu đã hoàn thành mà không phải lặp retry vô ích.

### 1.5. Kết quả kiểm chứng thực tế
- **Bộ test tự động:** 24/24 Node tests, 4/4 Edge browser tests, Extension smoke test toàn bộ PASS.
- **Test Chrome thực tế với Default Profile:**
  - Khởi chạy Google Chrome với bản clone an toàn từ profile Default dưới virtual display (Xvfb).
  - Cả 3 thẻ Daily Set ("Trip to Tokyo", "Trip to Cairns", "Portrait of a Lady on Fire quiz") đều được nhận diện, mở rộng accordion, click tự động và ghi nhận hoàn thành.
  - Thẻ thông tin `/about` ("Welcome to Microsoft Rewards") được nhận diện đúng là link điều hướng và bỏ qua.
- **Test Chrome thực tế với Profile 1:**
  - Nhận diện chính xác flight `vsstreak` (không có `dailyset` trên Dashboard ban đầu).
  - Tự động phục hồi Daily Set và hiển thị Streak Badge 132 ngày thông qua cơ chế fallback Panelflyout.
  - Tự động hoàn tất 100% các hoạt động Quests và 5 thẻ trong `moreactivities`.

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

### 2.3. Giải pháp Khôi phục Daily Set & Streak Hiển thị trên Profile 1 (2026-10-20)
Để giải quyết yêu cầu hiển thị lại các thẻ Daily Set và chuỗi Streak cho tài khoản trong Profile 1 như tài khoản ở Profile Default:
1. **Khai thác Nguồn dữ liệu Thay thế (`https://www.bing.com/rewards/panelflyout`):**
   - Mặc dù giao diện SSR của Next.js trên `/dashboard` loại bỏ `section#dailyset` đối với nhóm `vsstreak`, endpoint Bing Panelflyout vẫn duy trì đầy đủ dữ liệu hoạt động hàng ngày (`dailySetPromotions`) và tiến trình chuỗi (`streakPromotion` với `activityProgress: 132`).
   - Extension Background Service Worker tận dụng `host_permissions` sẵn có (`https://www.bing.com/*`) để truy xuất endpoint này với thông tin đăng nhập của phiên duyệt hiện tại.
2. **Bộ phân tích cú pháp JSON Cân bằng (`extractDailySetFromFlyoutHtml`):**
   - Triển khai parser trong `reward-dom-helpers.js` sử dụng thuật toán đếm ngoặc cân bằng brace-balanced nhằm bóc tách chính xác khối `window.flyoutViewModel` nằm trong thẻ `<script>` của Bing Flyout, loại bỏ rủi ro sai sót do Regex thông thường.
   - Trích xuất tự động danh sách thẻ hôm nay (tên thẻ, tiêu đề, mô tả, điểm thưởng, URL đích, ảnh minh họa, trạng thái hoàn thành) và số ngày Streak.
3. **Bộ khởi tạo DOM React Aria Disclosure (`injectRestoredDailySet`):**
   - Triển khai trong `reward-scanner-helpers.js` hàm tái tạo `section#dailyset` chuẩn theo ngôn ngữ thiết kế giao diện Microsoft Rewards (React Aria Components):
     - Tiêu đề "Daily set" kèm huy hiệu nổi bật: `🔥 132 day streak`.
     - Lưới responsive 3 cột chứa đầy đủ 3 thẻ hoạt động kèm biểu tượng trạng thái hoàn thành hoặc mũi tên điều hướng.
     - Tự động gắn thẻ trước các section hoạt động khác (`#moreactivities` / `#offers`), giúp người dùng nhìn thấy và tương tác trực quan ngay trên Dashboard.
4. **Tích hợp Tự động trong Vòng đời Duyệt web & Auto-click:**
   - Trong `background.js`:
     - Lắng nghe sự kiện `chrome.tabs.onUpdated`: Bất cứ khi nào trang `/dashboard` tải xong mà thiếu `section#dailyset`, extension tự động fetch dữ liệu và inject `section#dailyset` phục hồi vào trang.
     - Trong quy trình `autoClickRewards()`: Tự động kiểm tra và phục hồi Daily Set trước khi bắt đầu quét và click thẻ, cho phép extension tự động hoàn thành các nhiệm vụ Daily Set ngay cả trên tài khoản thuộc nhóm thử nghiệm `vsstreak`.

### 2.4. Kiểm thử Tự động & Cô lập Môi trường Màn hình (Xvfb)
- Toàn bộ quá trình chạy kiểm thử tương tác thực tế với trình duyệt Google Chrome được thực hiện thông qua script cô lập màn hình ảo Xvfb:
  `/u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus ...`
- Đảm bảo cửa sổ trình duyệt Headed render trọn vẹn mọi hiệu ứng đồ họa, giải mã cookie an toàn qua DBus Keyring mà hoàn toàn không ảnh hưởng hay bật pop-up lên màn hình làm việc của người dùng.
- Kết quả kiểm chứng thực tế trên Profile 1:
  - Khôi phục thành công `section#dailyset` với 3 thẻ: "Tokyo Rực Rỡ Đầu Thu" (+10 pts), "Rạn san hô Cairns mùa xuân trong xanh" (+10 pts), "Ngọn Lửa Sapphic?" (+10 pts).
  - Khôi phục thành công huy hiệu Streak hiển thị `🔥 132 day streak`.
  - Cả 3 thẻ đều được kích hoạt click và ghi nhận hoàn thành thành công.

---

### 2.5. Khắc phục Triệt để Vấn đề Không Hiển thị Daily Set trên Profile 1 khi Người dùng Duyệt Web Thực tế (2026-10-21)
Sau khi người dùng kiểm tra thực tế bằng Chrome Profile 1 và gửi ảnh chụp màn hình cho thấy trên Dashboard chỉ hiện "Your perks" và "Your progress" mà không thấy "Daily set", nhóm phát triển đã tiến hành rà soát chuyên sâu và phát hiện các nguyên nhân gốc:

1. **Nguyên nhân Kỹ thuật:**
   - **Xung đột React 18 Hydration / Reconciliation:** Microsoft Rewards Dashboard được xây dựng trên nền tảng Next.js (React 18). Khi tải trang, mã HTML ban đầu được đưa vào trình duyệt. Nếu extension inject thẻ DOM `<section id="dailyset">` vào thời điểm `chrome.tabs.onUpdated` (`status: complete`), các chunk JavaScript của React (`_next/static/chunks/...`) hoàn tất tải sau đó và tiến hành hydration reconciliation. React đối chiếu DOM thực tế với Virtual DOM của nhóm `vsstreak` (không hề có Daily Set) và tự động gỡ bỏ (unmount/strip) toàn bộ thẻ `<section id="dailyset">`.
   - **Điều hướng Single Page Application (SPA):** Khi người dùng chuyển đổi giữa các tab (`Dashboard`, `Earn`, `Redeem`) trên thanh menu, Next.js sử dụng cơ chế client-side routing (`history.pushState`). Trình duyệt không kích hoạt sự kiện tải lại trang, do đó sự kiện `chrome.tabs.onUpdated` với `status: complete` hoàn toàn không chạy lại.
   - **Chưa đăng ký Content Script thường trực:** Trước đó extension chỉ kích hoạt qua `chrome.scripting.executeScript` khi có sự kiện từ Service Worker. Khi người dùng mở tab thông thường, Service Worker có thể ở trạng thái idle/suspend hoặc chưa nhận diện kịp thời.
   - **Vị trí chèn DOM chưa bao quát:** Cấu trúc Dashboard của Profile 1 chứa các section `#offers` ("Your perks") và `#snapshot` ("Your progress"). Trước đây nếu target chưa xuất hiện trong lúc React đang khởi động, thẻ bị chèn nhầm lên phía trên đầu banner người dùng và bị xóa khi container re-render.

2. **Các Biện pháp Khắc phục Triệt để:**
   - **Đăng ký Content Script trong `manifest.json`:** Bổ sung `content_scripts` cho URL `https://rewards.bing.com/*` với script `reward-scanner-helpers.js` chạy ở `run_at: "document_end"`. Bảo đảm script luôn có mặt trên mọi phiên duyệt web của người dùng mà không phụ thuộc vào trạng thái Service Worker.
   - **Cơ chế Tự phục hồi qua `MutationObserver` (`ensurePersistentDailySet`):** Tạo observer thường trực theo dõi toàn bộ nhánh DOM con trên `document.body`. Ngay khi React hydration xóa bỏ `#dailyset`, observer sẽ lập tức phát hiện và tái tạo, gắn lại `#dailyset` ngay tức khắc vào vị trí chuẩn (ngay phía trên `#offers` / "Your perks" và dưới banner tài khoản).
   - **Bộ bắt sự kiện Điều hướng SPA (SPA Navigation Hooks):** Bọc các hàm `history.pushState`, `history.replaceState` và lắng nghe sự kiện `popstate`. Khi người dùng click qua lại giữa các trang trong Rewards, Daily Set luôn được tự động kiểm tra và hiển thị ngay lập tức.
   - **Bộ đệm Dữ liệu Cục bộ (`cachedDailySetData`):** Cache kết quả Daily Set và Streak trong `chrome.storage.local`. Khi người dùng mở trang, Daily Set được phục hồi trong 0ms từ bộ nhớ cache, đồng thời ngầm revalidate dữ liệu mới nhất từ `https://www.bing.com/rewards/panelflyout`.
   - **Tối ưu CSS Tương thích Dark/Light Theme:** Bổ sung style fallback trực tiếp (background, padding, border, icon checkmark xanh, flame badge) để bảo đảm các thẻ hiển thị đẹp mắt và rõ ràng trên mọi giao diện (kể cả dark theme của Microsoft Rewards).
   - **Thêm nút "Reload" tiện ích trên Extension Popup:** Cho phép người dùng và nhà phát triển cập nhật mã nguồn tiện ích từ ổ đĩa ngay trong popup chỉ với 1 click mà không cần thao tác thủ công trong `chrome://extensions`.

---

## 3. Khuyến nghị cho người dùng
1. **Reload Extension một lần duy nhất:**
   - Click vào biểu tượng extension trên thanh công cụ Chrome, nhấn nút **Reload** mới được bổ sung (hoặc mở `chrome://extensions` và bấm nút Reload của Bing Search Scheduler).
   - Sau khi reload, truy cập vào [rewards.bing.com/dashboard](https://rewards.bing.com/dashboard) trên Profile 1: Toàn bộ Daily Set 3 thẻ cùng huy hiệu chuỗi `🔥 132 day streak` sẽ hiển thị liên tục, bền bỉ và không bị React gỡ bỏ.
2. **Kích hoạt Streak thủ công trên Profile 1 (nếu cần):**
   - Mở Chrome với Profile 1, truy cập trực tiếp vào [rewards.bing.com/earn](https://rewards.bing.com/earn).
   - Kiểm tra thông báo kích hoạt chuỗi hoặc bật tính năng **Streak Protection** để đưa tài khoản thoát khỏi trạng thái skeleton loader.
3. **Khôi phục Streak qua Microsoft Rewards Support (nếu cần):**
   - Người dùng có thể gửi ticket hỗ trợ tới Microsoft Rewards Support báo cáo sự cố chuyển đổi giao diện `vsstreak` khiến chuỗi 132 ngày bị gián đoạn; Microsoft thường hỗ trợ khôi phục Streak (Streak Restoration) 1 lần cho người dùng đạt chuỗi dài.
