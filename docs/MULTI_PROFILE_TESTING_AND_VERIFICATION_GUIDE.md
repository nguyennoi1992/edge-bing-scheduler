# Hướng Dẫn Quy Trình Rà Soát, Fix Bug & Kiểm Thử Thật Đa Profile (Multi-Profile Testing & Verification Guide)

> **Tài liệu hướng dẫn chuẩn vận hành cho các phiên làm việc (sessions) tiếp theo**  
> Dự án: `edge-bing-scheduler` (Bing Search & Microsoft Rewards Extension)  
> Cập nhật lần cuối: 26/10/2026

---

## 1. Kiến Trúc & Đặc Thù Các Profile

Hệ thống hỗ trợ 2 profile Chrome chính với cơ chế hiển thị và ghi nhận Microsoft Rewards hoàn toàn khác nhau từ phía backend Microsoft:

| Đặc tính | Profile Default (`Default`) | Profile 1 (`Profile 1`) |
| :--- | :--- | :--- |
| **Đường dẫn profile** | `~/.config/google-chrome/Default` | `~/.config/google-chrome/Profile 1` |
| **Flighting Microsoft Rewards** | Tiêu chuẩn (Standard Desktop) | Flight `vsstreak` (Mobile/Flyout First) |
| **Daily Set trên `/dashboard`** | Native React Component (`#dailyset`) | Bị ẩn bởi backend (chỉ hiển thị trên Bing Mobile App / Panel Flyout) |
| **Cơ chế hiển thị trên Dashboard** | Render tự nhiên từ server/React | Extension phục hồi từ `panelflyout` thành `#ext-restored-dailyset` |
| **Cơ chế ghi nhận hoàn thành card** | Click trên desktop dashboard hoặc SERP search query | Cần gọi `POST https://www.bing.com/msrewards/api/v1/reportactivity` với `offerId`, `authKey` (hash), `userId` và giả lập Mobile Edge User-Agent |
| **Kiểm chứng hoàn thành** | `panelflyout` -> `complete: true`, `pointProgressMax` | `panelflyout` -> `complete: true`, `pointProgressMax` |

---

## 2. Quy Tắc Bắt Buộc Khi Chạy Kiểm Thử (Strict Operational Rules)

1. **Bảo vệ phiên làm việc của người dùng (Không chiếm Display):**
   - **Không** mở browser trực tiếp lên màn hình desktop chính (`DISPLAY=:0` hoặc default display).
   - **Bắt buộc** sử dụng script virtual display (`Xvfb`) tại:
     ```bash
     /u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME node <script.mjs>
     ```
2. **Bảo vệ dữ liệu Profile thật (Tránh xung đột Chrome Lock & Corrupt Data):**
   - Khi Chrome đang chạy trên máy của user, thư mục `~/.config/google-chrome` bị khóa (lock files: `SingletonLock`, `SingletonCookie`, `SingletonSocket`).
   - **Quy trình chuẩn hiện tại (Khuyến nghị):** Script `tests/verify-dual-profile-live.mjs` tự động tạo thư mục tạm cô lập riêng biệt (`mkdtempSync`), sao lưu database Cookie qua SQLite read-only (`sqlite3 src.backup(dst)` với URI `pathlib.Path(path).as_uri() + '?mode=ro'`) để tránh tranh chấp lock và mã hóa ký tự đặc biệt an toàn, tắt Chrome Sync ở cấp trình duyệt bằng cờ `--disable-sync`, tắt bộ lập lịch của extension trong bản clone bằng `chrome.storage.sync.set({ enabled: false })`, sử dụng cổng CDP ngẫu nhiên (`--remote-debugging-port=0`), và tự động dọn dẹp thư mục tạm khi kết thúc.
   - **Tránh:** Sử dụng đường dẫn cố định, ghi đè thư mục `/tmp/chrome-test-*` dùng chung, hoặc gọi lệnh `kill -9` / `pkill` bừa bãi làm tắt phiên làm việc thật của người dùng.
3. **Cài đặt Extension ở chế độ Developer:**
   - Extension được cài đặt unpacked trực tiếp từ thư mục dự án `/u01/tools/edge-bing-scheduler`.
   - Mọi sửa đổi file mã nguồn trong repo có hiệu lực trực tiếp khi extension worker reload.
   - **Yêu cầu bắt buộc khi test:** Phải reload extension (`chrome.runtime.reload()`) và đối soát hash SHA256 của file chạy trên extension so với file trên ổ đĩa trước khi ghi nhận kết quả. Script `tests/verify-dual-profile-live.mjs` đã tích hợp sẵn bước kiểm chứng này.

---

## 3. Cơ Chế Sao Chép Profile Tự Động (Profile Cloning Mechanism)

Trước đây, quy trình kiểm thử sử dụng script Python sao chép thủ công vào các thư mục cố định (`/tmp/chrome-test-p1`, `/tmp/chrome-test-default`), dễ dẫn đến ghi đè dữ liệu hoặc xung đột lock file. Các đoạn mã thủ công này đã bị xóa để tránh rủi ro vận hành (lịch sử lưu tại Git và các báo cáo cũ).

Hiện nay, script [`tests/verify-dual-profile-live.mjs`](file:///u01/tools/edge-bing-scheduler/tests/verify-dual-profile-live.mjs) tự động thực hiện quy trình sao chép an toàn:
1. Tạo thư mục tạm cô lập ngẫu nhiên qua `fs.mkdtempSync(path.join(os.tmpdir(), "edge-bing-live-"))` với quyền riêng tư `0700`.
2. Sao lưu cơ sở dữ liệu `Cookies` qua `sqlite3` API với URI chuẩn hóa an toàn (`pathlib.Path(...).as_uri() + '?mode=ro'` và `src.backup(dst)`), tránh tranh chấp lock và lỗi đường dẫn đặc biệt khi trình duyệt gốc đang chạy.
3. Sao chép các tệp cấu hình cần thiết (`Preferences`, `Local State`, `Secure Preferences`, `Network Persistent State`) và cấu hình phiên không khôi phục tab cũ.
4. Tự động dọn dẹp và xóa bỏ thư mục tạm khi kiểm thử hoàn tất trong khối `finally`.

---

## 4. Quy Trình Rà Soát & Bản Chất Kỹ Thuật (Root Cause & Fix)

### 4.1. Bản chất tại sao Profile 1 click không nhận hoàn thành (`complete: false`)
- Backend Microsoft phân loại Profile 1 vào flight thử nghiệm `vsstreak`.
- Trong flight này, trang kết quả tìm kiếm desktop (`/search?q=...`) gọi endpoint cũ `rewardsapp/reportActivity` nhưng backend trả về `"IsMobileClient": false` và từ chối cấp điểm.
- Ngược lại, trên Bing Mobile App hoặc Panel Flyout (`https://www.bing.com/rewards/panelflyout`), khi click vào card, client gửi request:
  ```http
  POST https://www.bing.com/msrewards/api/v1/reportactivity
  Content-Type: text/plain;charset=UTF-8

  {
    "ActivityType": "bingredirect",
    "ActivitySubType": "",
    "OfferId": "Global_DailySet_20261022_Child1",
    "Channel": "BingFlyout",
    "PartnerId": "BingRewards",
    "UserId": "<member_id>",
    "AuthKey": "<hash_from_flyout>",
    "ActivityCount": 1
  }
  ```
- Endpoint này ngay lập tức trả về:
  ```json
  {
    "OfferComplete": false,
    "EarnedCredits": 10,
    "ActivityComplete": true,
    "Balance": { "Available": 3213.0 },
    "ErrorDetail": { "ErrorCode": 0, "Message": "I_SUCCESS" }
  }
  ```
  và backend ghi nhận điểm + trạng thái hoàn thành ngay lập tức!

### 4.2. Giải pháp đã thực hiện trong Extension
1. **Trích xuất siêu dữ liệu:**
   - Trong `reward-dom-helpers.js`: Hàm `extractDailySetFromFlyoutHtml(html)` trích xuất đầy đủ `userId`, và đối với mỗi card: `offerId`, `hash` (AuthKey), `activityType`.
2. **Gắn dữ liệu vào DOM Card phục hồi:**
   - Trong `reward-scanner-helpers.js`: Gắn các thuộc tính `data-offer-id`, `data-auth-key`, `data-activity-type`, `data-user-id` vào thẻ `<a>` của `#ext-restored-dailyset`.
3. **Kích hoạt tự động khi click và khi tab search mở:**
   - Trong `background.js`:
     - Khi `autoClickRewards()` xử lý child tab của Daily Set: Injected script gửi `POST https://www.bing.com/msrewards/api/v1/reportactivity` trực tiếp từ origin `https://www.bing.com` của child tab (có đầy đủ cookie phiên, không bị CORS).
     - Trong `chrome.tabs.onUpdated`: Khi người dùng click thủ công trên web, tab tìm kiếm Bing Daily Set tải xong sẽ tự động đối soát với `cachedDailySetData` và gửi `reportactivity` nếu card chưa hoàn thành.
     - `declarativeNetRequest` session rule sửa User-Agent sang Edge Android trên toàn bộ `||bing.com/*` trong suốt quá trình xử lý Daily Set.

---

## 5. Cách Chạy Kiểm Thử Độc Lập & Kiểm Chứng Thật (Live Verification)

### 5.1. Chạy bộ kiểm thử tự động của dự án (Unit + Browser + Syntax)
```bash
./tests/run-all-tests.sh
```
Kết quả đạt yêu cầu: 32/32 Node tests pass (24 unit/functional tests + 8 regression tests), kiểm tra cú pháp thành công, Microsoft Edge fixtures & extension smoke test pass.

### 5.2. Chạy kịch bản kiểm tra trạng thái 2 profile qua Virtual Display (Khuyến nghị chuẩn)
Sử dụng script tự động hóa an toàn tại `tests/verify-dual-profile-live.mjs`:
```bash
/u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME node tests/verify-dual-profile-live.mjs
```
* **Đặc điểm:** Tự động clone profile vào thư mục tạm `0700`, sao lưu SQLite cookie qua mode read-only, mở popup extension, kích hoạt `chrome.runtime.reload()`, đối soát SHA256 mã nguồn runtime với repo, kiểm tra panelflyout + dashboard.
* **Quy ước mã thoát (Exit Semantics):** Áp dụng nguyên tắc fail-closed. Trả về exit code `1` nếu bất kỳ profile nào có Daily Set chưa hoàn thành trong ngày (ví dụ `Default` 0/3) hoặc thiếu dữ liệu/không xác thực; trả về exit code `0` chỉ khi tất cả profile đều hoàn thành (`complete`).

### 5.3. Ý Nghĩa & Cấu Trúc Dữ Liệu Chẩn Đoán JSON (Verifier Status Semantics)

Các đoạn mã kiểm tra CDP thủ công trước đây (chạy qua file tạm cố định như `/tmp/check-status.mjs`, cổng cố định `9444`, và kết thúc bằng `SIGKILL`) đã được loại bỏ để tránh xung đột cổng và tắt nhầm tiến trình. Lịch sử của các script này được lưu tại Git và các báo cáo cũ.

Hiện tại, việc kiểm tra trạng thái profile được thực hiện tập trung qua script tự động [`tests/verify-dual-profile-live.mjs`](file:///u01/tools/edge-bing-scheduler/tests/verify-dual-profile-live.mjs) (Mục 5.2). Mỗi profile được phân tích và xuất kết quả theo định dạng JSON có cấu trúc rõ ràng:

```json
{
  "profile": "Profile 1",
  "observedAt": "2026-10-25T11:32:59.065Z",
  "extensionPath": "/u01/tools/edge-bing-scheduler",
  "reload": {
    "verified": true,
    "before": "FD34B1635BB9D21B3C5965FAE6DEAA34",
    "after": "F480E5254439296130F9015B562F0955",
    "sourceVerified": true,
    "sourceHashes": {
      "background.js": "cd8aac2a2340c62957b786a40ec03d7816d6518485961d8683e994cb22fe8d95",
      "reward-dom-helpers.js": "d6a785b8c74b2a0a991aefcf71f5d9873e6ceed4f5c2e5ca159c098be4a029cd"
    }
  },
  "flyout": {
    "authenticated": true,
    "todayKey": "10/25/2026",
    "todayPresent": true,
    "availablePoints": 3351,
    "streakDays": 132,
    "cards": [
      { "name": "Global_DailySet_20261025_Child1", "complete": true, "points": 10, "max": 10 },
      { "name": "Global_DailySet_20261025_Child2", "complete": true, "points": 10, "max": 10 },
      { "name": "Global_DailySet_20261025_Child3", "complete": true, "points": 10, "max": 10 }
    ]
  },
  "dashboard": {
    "native": false,
    "restored": true,
    "cardCount": 3,
    "helpersCurrent": true,
    "readyCards": ["Ready to claim 0 Claim"]
  },
  "assessment": {
    "status": "complete",
    "completed": 3,
    "total": 3
  }
}
```

* **Ý nghĩa các trường đánh giá `assessment.status`:**
  - `"complete"`: Tài khoản đã xác thực, thẻ ngày hôm nay tồn tại đầy đủ, DOM dashboard hợp lệ, và toàn bộ thẻ Daily Set đạt `complete: true`.
  - `"incomplete"`: Tài khoản hợp lệ nhưng còn thẻ Daily Set chưa hoàn thành (ví dụ Default Profile hôm nay có 0/3 thẻ hoàn thành).
  - `"unavailable"`: Không thỏa mãn các điều kiện cơ bản (chưa reload extension, sai hash source, chưa đăng nhập, hoặc DOM dashboard thiếu thẻ).
* **Mã thoát toàn trình (Process Exit Code):** Verifier chạy tuần tự cả 2 profile. Nếu có bất kỳ profile nào có kết quả đánh giá không phải `"complete"`, toàn bộ tiến trình trả về mã thoát **Exit 1**. Chỉ khi tất cả profile đều đạt `"complete"`, tiến trình mới trả về **Exit 0**.

---

## 6. Danh Mục Tài Liệu Kỹ Thuật (Docs Index)

Tất cả các tài liệu kỹ thuật, nghiên cứu và báo cáo bugfix được lưu trữ tập trung tại thư mục `docs/`:

1. [`docs/MULTI_PROFILE_TESTING_AND_VERIFICATION_GUIDE.md`](file:///u01/tools/edge-bing-scheduler/docs/MULTI_PROFILE_TESTING_AND_VERIFICATION_GUIDE.md): Quy trình chuẩn rà soát, fix bug, chạy kiểm thử thật với các profile và quy tắc virtual display.
2. [`docs/verification-and-claim-fix-2026-10-25-dual-profile-live.md`](file:///u01/tools/edge-bing-scheduler/docs/verification-and-claim-fix-2026-10-25-dual-profile-live.md): Báo cáo kỹ thuật chi tiết ngày 25/10/2026 về sửa lỗi claim điểm 0 ("Ready to claim 0 Claim"), đồng bộ regex MAIN-world, kiểm chứng reload extension và kết quả kiểm thử thực tế 2 profile.
3. [`docs/investigation-and-fix-2026-10-15-dashboard-cards-and-profile1-streak.md`](file:///u01/tools/edge-bing-scheduler/docs/investigation-and-fix-2026-10-15-dashboard-cards-and-profile1-streak.md): Nhật ký kỹ thuật chi tiết về flight `vsstreak`, cơ chế phục hồi `#ext-restored-dailyset`, phát hiện endpoint `/msrewards/api/v1/reportactivity` và chứng minh thực nghiệm.
4. [`docs/optimization-2026-10-12-rewards-hydration-scheduler.md`](file:///u01/tools/edge-bing-scheduler/docs/optimization-2026-10-12-rewards-hydration-scheduler.md): Tối ưu hóa bộ quét hydration, cơ chế retry ổn định trên các trang Rewards React.
5. [`docs/bugfix-2026-08-22-edge-rewards-scripting-blocked.md`](file:///u01/tools/edge-bing-scheduler/docs/bugfix-2026-08-22-edge-rewards-scripting-blocked.md): Xử lý lỗi bảo vệ trang scripting trên Microsoft Edge.

---

## 7. Cơ Chế Xử Lý & Kiểm Thử Quests / Punchcards Yêu Cầu Bing App Exclusive

### 7.1. Cấu trúc nhiệm vụ "Rewards App exclusive"
Ví dụ điển hình: [`WW_pcparent_RewardsApp_weekly_Exclusive_Octw3_2026_punchcard`](https://rewards.bing.com/earn/quest/WW_pcparent_RewardsApp_weekly_Exclusive_Octw3_2026_punchcard)
- **Mục tiêu:** Nhận tối đa 70 điểm/tuần qua 8 hoạt động (1 tác vụ khởi tạo + 7 ngày trong tuần từ Sunday đến Saturday: `WW_pcchild2_urlreward_Sunday...` đến `WW_pcchild8_urlreward_Saturday...`).
- **Giao diện web desktop:** Microsoft Rewards khóa hiển thị với nút `<span role="link" aria-disabled="true" data-disabled="true">`, nhãn `"Rewards App exclusive"`, chứa link tìm kiếm kèm tham số telemetry chuyên biệt:
  `https://www.bing.com/search?q=...&form=ML2Y2H&OCID=ML2Y2H&PUBL=RewardsDO&CREA=ML2Y2H&rnoreward=1`
- **Ý nghĩa tham số:**
  - `form=ML2Y2H`, `OCID=ML2Y2H`, `PUBL=RewardsDO`: Mã định danh chiến dịch Desktop Rewards App / Bing App.
  - `rnoreward=1`: Chỉ định backend không trừ quota search thông thường mà chuyển trực tiếp sang hệ thống Punchcard / Quest tracking.

### 7.2. Giải pháp tự động hóa của Extension
1. **Bỏ qua rào cản `aria-disabled="true"` trên web:**
   - Trong `isActionableQuestActivity` và `getQuestActivities`, nếu phần tử có nhãn `"rewards app"`, `"bing app"`, `"exclusive"` hoặc chứa các cờ `RewardsDO`, `ML2Y2H`, `rnoreward=1`, extension giữ lại và xử lý như một thẻ hoạt động hợp lệ thay vì bỏ qua.
2. **Bóc tách cấu trúc từng dòng hoạt động (`.flex-row`):**
   - Bộ gom nhóm DOM mở rộng `.flex-row, [role='row'], [role='listitem']` tách biệt chính xác cả 7 hoạt động độc lập bên trong cùng một bảng danh sách.
3. **Mở tab dự phòng (`fallbackTab`):**
   - Do phần tử là thẻ `<span>` có thuộc tính `href`, sự kiện `.click()` DOM thuần có thể không kích hoạt chuyển hướng. Extension phát hiện nếu không có tab mới mở ra, sẽ tự động dùng `chrome.tabs.create({ url: fullHref, active: true })`.
4. **Giả lập môi trường Mobile / Bing App với DNR:**
   - Bật `enableRewardMobileEmulation()` (DNR Rule 9021 với UA Edge Android: `EdgA/130.0.0.0`, `sec-ch-ua-mobile: ?1`, `sec-ch-ua-platform: "Android"`) trong suốt chu trình chạy quest activities.
   - Tiêm đè `navigator.userAgent` và `navigator.userAgentData` vào tab con ở MAIN world để telemetry client-side của Bing xác nhận hợp lệ.

### 7.3. Quy trình xác minh độc lập
```bash
/u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME node /tmp/test-extension-injected-quest-scan.mjs
```
Kết quả kiểm tra:
```json
Verified Scanner Output: {
  "count": 7,
  "items": [
    { "label": "Rewards App exclusive, Indoor herbs", "isExclusiveApp": true },
    { "label": "Rewards App exclusive, HIIT workout at home", "isExclusiveApp": true },
    { "label": "Rewards App exclusive, Laugh out loud", "isExclusiveApp": true },
    { "label": "Rewards App exclusive, Westerlies explained", "isExclusiveApp": true },
    { "label": "Rewards App exclusive, Puppy pics!", "isExclusiveApp": true },
    { "label": "Rewards App exclusive, Writing for beginners", "isExclusiveApp": true },
    { "label": "Rewards App exclusive, Learn a new skill", "isExclusiveApp": true }
  ]
}
```

---

## 8. Cơ Chế Tự Động Hóa Flow "Ready to claim" / "Claim points"

### 8.1. Cấu trúc DOM & Rào cản kỹ thuật
Trên trang `https://rewards.bing.com/dashboard`, người dùng thường có các khoản điểm thưởng sẵn sàng để nhận ("Ready to claim"), ví dụ: *"First search of the day bonus"* (6 điểm).
- **Thẻ kích hoạt trên Dashboard:**
  ```html
  <button class="... rounded-cornerCardDefault" data-rac="" type="button" aria-expanded="false" data-react-aria-pressable="true">
    Text: "Ready to claim\n\n6\n\nClaim"
  </button>
  ```
- **Flyout Dialog khi mở ra:**
  `<section role="dialog" data-rac="" class="outline-0" aria-labelledby="...">` với container `shadow-shadowFlyout bg-flyout`.
  - Bên trong có skeleton loader khi mới mở, sau đó render danh sách hoạt động kèm nút xác nhận:
    ```html
    <button class="... rounded-cornerCardDefault" data-rac="" type="button" data-react-aria-pressable="true">
      <p>6</p>
      <div>Pending</div>
      <div class="... bg-bgCtrlBrandRest text-fgCtrlOnBrandRest">
        <span>Claim points</span>
      </div>
    </button>
    ```
  - Và nút đóng flyout: `<button slot="close" aria-label="Close">`.

### 8.2. Nguyên nhân lỗi trước đây
1. **Tìm kiếm phần tử bao phủ quá rộng:** Quét `document.querySelectorAll("*")` khớp phải các thẻ cha cấp cao (`<html>`, `<body>`, `div.flex`), dẫn đến `cardContainer.querySelector("button")` lấy nhầm nút điều hướng khác thay vì nút "Ready to claim".
2. **Sai lệch chuỗi sự kiện React Aria:** React Aria (`usePress`) yêu cầu chuỗi PointerEvents hoàn chỉnh (`pointerdown` với `pointerId: 1`, `pointerType: "mouse"`, `isPrimary: true`, `pressure: 0.5`) trên chính phần tử `<button data-react-aria-pressable="true">`, không chỉ gọi `.click()` trên `<span>` con.
3. **Mẫu regex chưa bao quát và lệch môi trường tiêm (MAIN-world):** Thẻ ban đầu có text `"Ready to claim 6 Claim"`, và nút confirm có text `"6 Pending Claim points"` hoặc chỉ `"Claim"` / `"Nhận"`. Regex cũ đòi hỏi cụm từ cố định `"claim points"` nên bỏ qua. Đồng thời, `injectDomHelpers` trước đây không truyền nguồn regex mới nhất sang MAIN-world và không làm mới helper khi regex bị cũ.
4. **Không đợi flyout tải xong dữ liệu:** Flyout mở ra có độ trễ tải backend; việc kiểm tra nút confirm ngay tại thời điểm flyout mount sẽ gặp mảng rỗng (skeleton loader).
5. **Bịa đặt 1 điểm và click lặp thẻ có 0 điểm:** Biểu thức `points: points || 1` tự gán 1 điểm khi thẻ trả về 0 điểm (ví dụ đã claim xong và hiển thị `"Ready to claim 0 Claim"`), gây click lặp lại liên tục.

### 8.3. Giải pháp chuẩn hóa
1. **Ưu tiên quét trực tiếp button / pressable:**
   Duyệt `button, [role='button'], [data-react-aria-pressable='true'], a` kết hợp `READY_TO_CLAIM_LABEL_RE` mở rộng:
   ```javascript
   /^\s*(?:ready to claim|sẵn sàng nhận|可领取|prêt à réclamer|bereit zum einlösen|listo para reclamar|готово к получению)(?:[\s!:]*(?:\+\s*)?\d[\d,.]*(?:\s*(?:points?|pts?|claim|nhận|reclamar|einlösen))?[\s!:]*|[\s!:]*)*(?:claim|nhận)?\s*$/i
   ```
2. **Đồng bộ biểu thức regex vào MAIN-world:**
   Truyền `READY_TO_CLAIM_LABEL_RE.source` và `CLAIM_MATCH_RE.source` qua tham số injection của `executeRewardsScript`. So khớp `.source` trong `helpersReady` để tự động làm mới helper nếu ngữ cảnh trang chứa regex cũ.
3. **Loại bỏ fallback bịa điểm và chặn thẻ <= 0 điểm:**
   Giữ nguyên giá trị `points` thực tế trích xuất từ DOM; lặp qua các nút ready to claim và chỉ trả về khi `points > 0`, tiếp tục đánh giá sau các nút 0 điểm; sử dụng guard `!/\d/.test(text)` để chặn mọi số 0 dính liền nhãn (`0points`, `0Claim`), chuẩn hóa predicate `isSingleActivity` loại trừ major sections, xử lý đúng `findRewardCardRoots` tìm kiếm descendants (coi nút tự thân không có con là 1 root), loại trừ container nhiều thẻ và fail-closed khi `points <= 0` (`{ clicked: false, claimedPoints: 0, reason: "not_ready" }`).
4. **Mô phỏng React Aria Pointer Events:**
   Kích hoạt đầy đủ `pointerdown` -> `mousedown` -> `pointerup` -> `mouseup` -> `click` trên nút bấm mục tiêu.
5. **Loại bỏ banner cookies và polling đợi flyout render:**
   Bỏ qua các phần tử cố định dính đáy (`bottom-0` & `sticky`), poll kiểm tra nút confirm bên trong `<section role="dialog">` đến khi xuất hiện.
6. **Nhấp nút confirm và dọn dẹp:**
   Kích hoạt claim trên button confirm, đợi 2.5s để mutation server cập nhật, sau đó nhấn nút `button[slot="close"]` để đóng flyout.
7. **Kiểm chứng thực tế:**
   Đã chạy kiểm chứng trên cả `Profile 1` và `Default Profile` qua virtual display (`run-with-virtual-display.sh`):
   - Ngày 25/10/2026: Profile Default nhận thành công +112 điểm (2413 -> 2525, pending 112 -> 0); Profile 1 nhận thành công +12 điểm (3351 -> 3363, pending 12 -> 0) trên mã nguồn `cd8aac2a...`.
   - Ngày 26/10/2026: Kiểm chứng chỉ đọc lúc 13:38 - 13:39 VN (`final-source-verifier-4e4292.log`) ghi nhận cả 2 profile đạt 3/3 thẻ DailySet, verifier exit code 0. Đợt targeted claim mới trên mã nguồn `4e429271...` ghi nhận thành công trọn vẹn: Profile Default nhận +3 điểm (2594 -> 2597, pending 3 -> 0); Profile 1 nhận +3 điểm (3402 -> 3405, pending 3 -> 0).
   - Thẻ điểm trên cả 2 tài khoản cập nhật chính xác về trạng thái: `"Ready to claim 0 Claim"`. Không còn hiện tượng click lặp trên thẻ 0 điểm.

