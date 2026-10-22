# Hướng Dẫn Quy Trình Rà Soát, Fix Bug & Kiểm Thử Thật Đa Profile (Multi-Profile Testing & Verification Guide)

> **Tài liệu hướng dẫn chuẩn vận hành cho các phiên làm việc (sessions) tiếp theo**  
> Dự án: `edge-bing-scheduler` (Bing Search & Microsoft Rewards Extension)  
> Cập nhật lần cuối: 22/10/2026

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
   - **Tuyệt đối không** mở browser trực tiếp lên màn hình desktop chính (`DISPLAY=:0` hoặc default display).
   - **Bắt buộc** sử dụng script virtual display (`Xvfb`) tại:
     ```bash
     /u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME node <script.mjs>
     ```
2. **Bảo vệ dữ liệu Profile thật (Tránh xung đột Chrome Lock & Corrupt Data):**
   - Khi Chrome đang chạy trên máy của user, thư mục `~/.config/google-chrome` bị khóa (lock files: `SingletonLock`, `SingletonCookie`, `SingletonSocket`).
   - Sao chép các file cần thiết sang thư mục tạm trước khi test:
     - `Local State`
     - Profile directory: `Preferences`, `Cookies`, `Network Persistent State`, `Local Storage`, `Local Extension Settings`.
   - Các thư mục test chuẩn:
     - Profile 1: `/tmp/chrome-test-p1`
     - Profile Default: `/tmp/chrome-test-default`
3. **Cài đặt Extension ở chế độ Developer:**
   - Extension được cài đặt unpacked trực tiếp từ thư mục dự án `/u01/tools/edge-bing-scheduler`.
   - Mọi sửa đổi file mã nguồn trong repo có hiệu lực trực tiếp khi extension worker reload.

---

## 3. Cách Sao Chép Profile Kiểm Thử (Profile Test Setup Script)

Sử dụng lệnh Python nhanh để chuẩn bị môi trường test cô lập:

```bash
python3 -c '
import os, shutil

src_root = os.path.expanduser("~/.config/google-chrome")

def clone_profile(profile_name, dst_root):
    os.makedirs(dst_root, exist_ok=True)
    if os.path.exists(f"{src_root}/Local State"):
        shutil.copy2(f"{src_root}/Local State", f"{dst_root}/Local State")
    dst_prof = f"{dst_root}/{profile_name}"
    os.makedirs(dst_prof, exist_ok=True)
    src_prof = f"{src_root}/{profile_name}"
    for item in ["Preferences", "Cookies", "Network Persistent State", "Local Storage", "Local Extension Settings"]:
        s = f"{src_prof}/{item}"
        d = f"{dst_prof}/{item}"
        if os.path.exists(s):
            if os.path.isdir(s):
                if os.path.exists(d): shutil.rmtree(d)
                shutil.copytree(s, d)
            else:
                shutil.copy2(s, d)
    print(f"Cloned {profile_name} to {dst_root}")

clone_profile("Profile 1", "/tmp/chrome-test-p1")
clone_profile("Default", "/tmp/chrome-test-default")
'
```

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
Kết quả đạt yêu cầu: 24/24 Node tests pass, kiểm tra cú pháp thành công, Microsoft Edge tests pass.

### 5.2. Chạy kịch bản kiểm tra trạng thái 2 profile qua Virtual Display
Sử dụng script có sẵn tại `tests/verify-dual-profile-live.mjs`:
```bash
/u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME node tests/verify-dual-profile-live.mjs
```

### 5.3. Cách kiểm tra trực tiếp trạng thái panelflyout của một profile qua CDP
Tạo file kiểm tra nhanh (ví dụ `/tmp/check-status.mjs`):
```javascript
import { spawn } from "node:child_process";

async function check() {
  const chromeProc = spawn("google-chrome", [
    "--user-data-dir=/tmp/chrome-test-p1",
    "--profile-directory=Profile 1",
    "--remote-debugging-port=9444",
    "--no-first-run",
    "--no-default-browser-check",
    "https://www.bing.com/rewards/panelflyout"
  ], { stdio: "ignore" });

  await new Promise(r => setTimeout(r, 6000));
  const list = await (await fetch("http://127.0.0.1:9444/json/list")).json();
  const page = list.find(t => t.type === "page");
  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(() => {
        const vm = window.flyoutViewModel;
        const today = new Date();
        const key = (today.getMonth() + 1) + "/" + today.getDate() + "/" + today.getFullYear();
        const dsp = vm?.flyoutResult?.dailySetPromotions?.[key] || [];
        return dsp.map(c => ({ name: c.name, complete: c.complete, points: c.pointProgress }));
      })()`,
      returnByValue: true
    }
  }));

  ws.onmessage = (ev) => {
    const res = JSON.parse(ev.data);
    if (res.id === 1) {
      console.log("Daily Set Status:", JSON.stringify(res.result?.result?.value, null, 2));
      ws.close();
      chromeProc.kill("SIGKILL");
    }
  };
}
check();
```
Chạy với virtual display:
```bash
/u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME node /tmp/check-status.mjs
```

Tiêu chí xác nhận thành công:
```json
Daily Set Status: [
  { "name": "Global_DailySet_..._Child1", "complete": true, "points": 10 },
  { "name": "Global_DailySet_..._Child2", "complete": true, "points": 10 },
  { "name": "Global_DailySet_..._Child3", "complete": true, "points": 10 }
]
```

---

## 6. Danh Mục Tài Liệu Kỹ Thuật (Docs Index)

Tất cả các tài liệu kỹ thuật, nghiên cứu và báo cáo bugfix được lưu trữ tập trung tại thư mục `docs/`:

1. [`docs/MULTI_PROFILE_TESTING_AND_VERIFICATION_GUIDE.md`](file:///u01/tools/edge-bing-scheduler/docs/MULTI_PROFILE_TESTING_AND_VERIFICATION_GUIDE.md): Quy trình chuẩn rà soát, fix bug, chạy kiểm thử thật với các profile và quy tắc virtual display.
2. [`docs/investigation-and-fix-2026-10-15-dashboard-cards-and-profile1-streak.md`](file:///u01/tools/edge-bing-scheduler/docs/investigation-and-fix-2026-10-15-dashboard-cards-and-profile1-streak.md): Nhật ký kỹ thuật chi tiết về flight `vsstreak`, cơ chế phục hồi `#ext-restored-dailyset`, phát hiện endpoint `/msrewards/api/v1/reportactivity` và chứng minh thực nghiệm.
3. [`docs/optimization-2026-10-12-rewards-hydration-scheduler.md`](file:///u01/tools/edge-bing-scheduler/docs/optimization-2026-10-12-rewards-hydration-scheduler.md): Tối ưu hóa bộ quét hydration, cơ chế retry ổn định trên các trang Rewards React.
4. [`docs/bugfix-2026-08-22-edge-rewards-scripting-blocked.md`](file:///u01/tools/edge-bing-scheduler/docs/bugfix-2026-08-22-edge-rewards-scripting-blocked.md): Xử lý lỗi bảo vệ trang scripting trên Microsoft Edge.

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
