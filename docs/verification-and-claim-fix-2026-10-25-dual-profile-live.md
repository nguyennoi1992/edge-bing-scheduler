# Báo Cáo Kỹ Thuật: Khắc Phục Luồng Claim Thưởng, Đồng Bộ Script Injection & Kiểm Thử Thật Đa Profile

> **Ngày thực hiện:** 25/10/2026 - 26/10/2026 (Múi giờ: Asia/Ho_Chi_Minh)  
> **Dự án:** `edge-bing-scheduler`  
> **Trạng thái:** Hoàn tất, sẵn sàng tích hợp

---

## 1. Tóm Tắt Tổng Quan

Báo cáo này ghi nhận việc rà soát, xử lý các lỗi logic trong cơ chế nhận điểm thưởng ("Ready to claim") trên trang Microsoft Rewards Dashboard, đồng bộ hóa biểu thức chính quy (RegExp) giữa extension service worker và môi trường trang (MAIN-world), đồng thời cập nhật script kiểm thử thực tế đa profile (`Default` và `Profile 1`) theo cơ chế fail-closed và cô lập dữ liệu.

Tất cả 32 test Node.js (bao gồm 8 test hồi quy mới), kiểm tra cú pháp, manifest, shell scripts và bộ test Microsoft Edge browser fixtures đều vượt qua thành công (`PASS`).

---

## 2. Phân Tích Nguyên Nhân Gốc Rễ (Root Causes) & Phạm Vi Sở Hữu

### 2.1. Lệch đồng bộ biểu thức chính quy trong MAIN-world (`background.js`)
* **Vị trí:** `background.js` (hàm `injectDomHelpers`).
* **Hiện tượng:** Hàm tiêm helper vào MAIN-world sử dụng một biểu thức regex tĩnh cũ, không cập nhật theo các hằng số chia sẻ `READY_TO_CLAIM_LABEL_RE` và `CLAIM_MATCH_RE` từ `reward-dom-helpers.js`. Điều này khiến các nhãn mới như `"Ready to claim 6 Claim"` hoặc nút confirm biến thể không được nhận diện chính xác trong ngữ cảnh trang.
* **Hạn chế của guard kiểm tra:** Biến cờ `window.__rewardDomHelpersInjected` trước đây chỉ kiểm tra sự tồn tại của hàm mà không kiểm tra xem regex trong `window.READY_TO_CLAIM_LABEL_RE` và `window.CLAIM_MATCH_RE` có khớp với source mới nhất từ extension hay không. Khi trang đã có helper cũ, extension không làm mới lại helper.

### 2.2. Bịa đặt 1 điểm và click lặp thẻ có 0 điểm (`background.js`)
* **Vị trí:** `background.js` (hàm `claimReadyPoints` và `findReadyToClaimCard`).
* **Hiện tượng:** Đoạn mã cũ sử dụng toán tử fallback `points: points || 1`. Khi thẻ điểm hiển thị 0 điểm (ví dụ thẻ đã claim xong hiển thị `"Ready to claim 0 Claim"`), hàm tự động gán giá trị `1` điểm.
* **Hậu quả:** Hàm `claimReadyPoints` nhận định vẫn còn điểm để nhận, tiếp tục kích hoạt click vào thẻ 0 điểm nhiều lần, gây tốn tài nguyên và tiềm ẩn lỗi click lặp vô ích.

### 2.3. Rủi ro trong công cụ kiểm thử thực tế cũ (`tests/verify-dual-profile-live.mjs`)
* **Thư mục cố định và port cố định:** Sử dụng cứng `/tmp/chrome-test-p1`, `/tmp/chrome-test-default` và port `9444`, `9445`, dễ gây xung đột tiến trình hoặc ghi đè dữ liệu nếu có phiên chạy song song.
* **Khóa SQLite Cookie:** Sao chép file `Cookies` dạng binary thô (`copyFileSync`) khi Chrome đang chạy có thể gặp database locks hoặc corrupt dữ liệu phiên.
* **Thiếu kiểm chứng reload extension:** Không kiểm tra service worker target ID của extension có thực sự tái khởi động (`chrome.runtime.reload()`) hay chưa, và không đối soát mã nguồn runtime với mã nguồn file trong repository.
* **Đếm thẻ dashboard chưa bao quát:** Trước đây chỉ đếm `a[href]`, có thể bỏ sót các thẻ hiển thị dưới dạng buttons/pressables hoặc đếm trùng các liên kết con.
* **Dọn dẹp tiến trình thiếu an toàn:** Dùng `SIGKILL` trực tiếp hoặc bỏ sót tiến trình Chrome chạy ngầm.
* **Đánh giá lỏng lẻo:** Cho phép pass ngay cả khi không có dữ liệu thẻ hôm nay hoặc không xác thực được tài khoản.

---

## 3. Chi Tiết Các Thay Đổi Mã Nguồn (Code Changes)

Tuân thủ nguyên tắc thay đổi nhỏ nhất đáp ứng đúng phạm vi:

### 3.1. `background.js`
* Truyền trực tiếp `READY_TO_CLAIM_LABEL_RE.source` và `CLAIM_MATCH_RE.source` vào `args` của `executeRewardsScript` trong `injectDomHelpers`.
* Kiểm tra `helpersReady` bao gồm cả việc so khớp `.source` của `window.READY_TO_CLAIM_LABEL_RE` và `window.CLAIM_MATCH_RE`. Nếu regex bị cũ hoặc thiếu, cờ được làm mới và các helper được khởi tạo lại chính xác.
* Trong `findReadyToClaimCard`:
  - Lặp qua tất cả nút matching (`for (const directCard of allButtons)`), chỉ trả về khi `points > 0` và tiếp tục đánh giá các nút tiếp theo nếu gặp nút 0 điểm hoặc không xác định (thay vì dùng `allButtons.find` thoát sớm ở nút đầu tiên).
  - Trả về trực tiếp giá trị `points` thực tế trích xuất được từ DOM (thay vì `points || 1`).
  - Bảo toàn `cardContainer = directCard` đối với trường hợp nút có số điểm dương hoặc số 0 rõ ràng.
  - Chuẩn hóa hàm kiểm tra cục bộ `isSingleActivity` dùng chung cho cả cha của nút trực tiếp và container fallback candidates: loại trừ major sections (`section, body, #dailyset, #moreactivities, #ext-restored-dailyset`), nhận diện đúng đặc tính `findRewardCardRoots` tìm kiếm descendants (coi nút tự thân không có action con là 1 root thay vì so sánh cứng `length === 1`), và loại trừ các container nhiều thẻ (`roots.length > 1`).
  - Chỉ kích hoạt tìm `parentCard` khi nút trực tiếp không chứa số điểm (`points === 0 && !/\d/.test(text)`, chặn mọi số 0 dính liền nhãn như `"Ready to claim 0points Claim"` hay `"0Claim"`), container cha đại diện đúng một activity root (`isSingleActivity(parentCard)`) và có điểm dương kiểm chứng được (`parentPoints > 0`). Nếu container cha là collection nhiều thẻ hoặc section, helper fail-closed không nhận điểm cha.
  - Nếu text của nút bấm có số 0 rõ ràng (như `"Ready to claim 0 Claim"`), điểm được giữ nguyên là `0` và **không** fallback lên cha.
  - Trong vòng lặp fallback candidates: loại bỏ `section` khỏi `cand.closest`, bảo toàn điểm dương tự thân của nút/pressable, từ chối container nhiều thẻ hoặc major section qua `isSingleActivity`, và fail-closed trước explicit zero / unknown.
* Trong `claimReadyPoints`, bổ sung kiểm tra chặn:
  ```javascript
  if (!readyCard || readyCard.points <= 0) {
    console.log("[Rewards-Debug] claimReadyPoints: No ready-to-claim card found.");
    return { clicked: false, claimedPoints: 0, reason: "not_ready" };
  }
  ```

### 3.2. Bộ test hồi quy
1. **`tests/injected-reward-helpers.test.mjs`:**
   * Trích xuất mã hàm nguồn bằng `extractFunction` với regex boundaries có điều kiện assertion thứ tự bắt đầu / kết thúc (`startPattern`, `endPattern`), không phụ thuộc khoảng trắng thụt lề tĩnh.
   * Kiểm thử việc tiêm helper vào MAIN-world sử dụng đúng source regex và tự động thay thế helper khi helper cũ bị lỗi thời.
   * Kiểm thử luồng claim với thẻ 0 điểm (`"Ready to claim 0 Claim"`): xác nhận `clicked === false`, `claimedPoints === 0` và số lần click phát sinh chính xác bằng `0`.
   * Kiểm thử nút có điểm dương tự click chính nó và không kích hoạt click lên container cha (`ownPosParent.clicks === 0`).
   * Kiểm thử nút 0 điểm rõ ràng không click kể cả khi container cha có điểm dương (`explicitZeroParent.clicks === 0`).
   * Kiểm thử fallback đọc điểm từ container cha khi nút không có số, bảo toàn số 0 rõ ràng, và fail-closed khi cả nút lẫn cha đều không có số điểm kiểm chứng được.
2. **`tests/live-verification.test.mjs`:**
   * Kiểm thử các nhánh hợp lệ và fail-closed của hàm đánh giá profile `assessProfile`: từ chối khi chưa reload, chưa xác thực, thiếu thẻ hôm nay, trùng lặp thẻ, dashboard chưa sẵn sàng; từ chối khi neither native nor restored (`!(native || restored)`); từ chối bất kỳ sai lệch số lượng thẻ nào (`cardCount !== cards.length`), bao gồm cả trường hợp thiếu thẻ (`cardCount = 1`) và thừa controls (`cardCount = 3`); chấp nhận cả 2 hình thức render (Native `#dailyset` và Restored `#ext-restored-dailyset`).
   * Kiểm thử `readDashboard` lọc bỏ section chrome, header disclosure (`slot="trigger"`, `aria-expanded`) và nút info (`About Daily set`, `help`, `?`) bằng `isRewardSectionChrome` và các bộ lọc thẻ hoạt động thực tế, đếm chính xác 3 thẻ từ cụm mock có 5 phần tử. Khôi phục chuẩn trạng thái vắng mặt của `window`/`document` trên `globalThis` qua `Object.hasOwn` và property descriptor để tránh làm bẩn môi trường test.
   * Kiểm thử `readFlyout` fail-closed qua tham số Date cố định tại mốc nửa đêm (fixed midnight test): bảo đảm không đếm các thẻ đã hoàn thành của hôm qua (`10/25/2026`) hay tương lai (`10/27/2026`) cho ngày hiện tại (giữ `todayPresent: false`, `cards: []`, đánh giá trả về `unavailable`), và chỉ nhận diện chính xác thẻ của đúng ngày yêu cầu khi xuất hiện.
   * Kiểm thử `readDashboard` biên dịch biểu thức chính quy chuẩn `READY_TO_CLAIM_LABEL_RE` một lần duy nhất, chuẩn hóa khoảng trắng của text trên nút bấm trước khi khớp, hỗ trợ đầy đủ các ngôn ngữ không phải tiếng Anh (Trung, Đức, Nga, Việt, Tây Ban Nha, Pháp) và từ chối chính xác các nút negative control. Khôi phục hoàn toàn các biến môi trường toàn cục `document` và `window`.

### 3.3. `tests/verify-dual-profile-live.mjs`
* Tạo thư mục clone cô lập bằng `fs.mkdtempSync(path.join(os.tmpdir(), "edge-bing-live-"))` với phân quyền an toàn `0700`.
* Sử dụng Python `sqlite3` API với URI chuẩn hóa `pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro'` (`src.backup(dst)`) để sao lưu database Cookies ở chế độ chỉ đọc, mã hóa an toàn các ký tự đặc biệt (khoảng trắng, `#`, `?`) và tránh tranh chấp file lock khi trình duyệt gốc đang chạy.
* Sử dụng cổng gỡ lỗi động (`--remote-debugging-port=0`) và đọc cổng từ `DevToolsActivePort`.
* Trật tự khởi tạo an toàn: gắn bộ đón lỗi `browserProcess.once("error")` và `browserClosed` (bắt sự kiện `"close"`) ngay lập tức sau khi spawn tiến trình, trước khi đóng tệp log `fs.closeSync(log)`.
* Bọc try/catch khi kiểm tra tệp khóa virtual display `/tmp/.X${display}-lock` và `/proc/${pid}/comm`.
* Mở popup extension, tắt bộ lập lịch của extension trong bản clone (`chrome.storage.sync.set({ enabled: false })`), kích hoạt `chrome.runtime.reload()` (Chrome Sync được tắt ở cấp trình duyệt bằng cờ `--disable-sync`), xác minh target ID của service worker thay đổi trước và sau reload.
* Tải nội dung `background.js` và `reward-dom-helpers.js` từ chính URL extension runtime, băm SHA256 và so khớp byte UTF-8 nghiêm ngặt với file trên ổ đĩa (không làm suy yếu danh tính mã nguồn bằng cách chuẩn hóa CRLF).
* `readFlyout` chẩn đoán `requestedDay` và `availableDateKeys`, duy trì hợp đồng chỉ đọc đúng ngày cục bộ hiện tại (fail-closed, không fallback sang ngày khác khi lệch múi giờ).
* `readDashboard` tái sử dụng `window.findRewardCardRoots` từ helper và lọc bỏ các điều khiển section chrome, header disclosure, info buttons để đếm chính xác số thẻ hoạt động trên dashboard (trả về đúng 3 thẻ, không bị lệch thành 5); đồng thời biên dịch `new RegExp(readySource, 'i')` một lần duy nhất, chuẩn hóa khoảng trắng nút trước khi so khớp chẩn đoán `readyCards`, tái sử dụng trọn vẹn regex chuẩn từ hằng số chia sẻ.
* `assessProfile` áp dụng so khớp số lượng thẻ chặt chẽ `cardCount !== cards.length` để ngăn chặn controls dư thừa che giấu các thẻ bị thiếu.
* Đóng kết nối CDP qua `Browser.close` và dọn dẹp sạch sẽ thư mục tạm trong khối `finally`.
* Cơ chế đánh giá Fail-Closed: trả về exit code `1` nếu bất kỳ profile nào có trạng thái `incomplete` (chưa xong thẻ trong ngày) hoặc `unavailable`.

---

## 4. Kết Quả Kiểm Thử (Verification & Test Results)

### 4.1. Bộ test tự động (Automated Test Suite)
Lệnh thực thi:
```bash
./tests/run-all-tests.sh
```
Kết quả:
* **Node.js Tests:** 32/32 tests passed (bao gồm 24 test chức năng & helpers hiện có + 8 test hồi quy: 3 trong `tests/injected-reward-helpers.test.mjs` và 5 trong `tests/live-verification.test.mjs`). Thời gian chạy ~86ms.
* **Cú pháp JavaScript:** Kiểm tra cú pháp `--check` toàn bộ 9 file JS cốt lõi thành công.
* **Manifest & Shell Scripts:** Cú pháp JSON manifest và các script bash hợp lệ.
* **Microsoft Edge Browser Tests:** Vượt qua cả 4 fixtures (`earn card scanning`, `earn delayed hydration`, `dashboard card scanning`, `dashboard live HTML card scanning`).
* **Extension Smoke Test:** Extension nạp thành công với service worker `nfhfoeifnelcgcalhnbidjdmgohcfbon`.
* Log chi tiết đã lưu: `/tmp/edge-bing-live-20261025-gp7SPA/final-suite-redacted.log`.

### 4.2. Bằng chứng kiểm thử thực tế trên tài khoản thật (Live Verification Evidence)

*(Toàn bộ thông tin định danh cá nhân, email, auth keys, cookies đã được loại bỏ/redact để đảm bảo an toàn bảo mật).*

#### A. Giai đoạn Targeted Claim ban đầu (Mã nguồn ban đầu SHA256 `cd8aac2a...`)
Bằng chứng lưu tại:
* `/tmp/edge-bing-live-20261025-gp7SPA/targeted-claim.log` & `targeted-claim.json`
* `/tmp/edge-bing-live-20261025-gp7SPA/claim-started-Default.json` & `claim-started-Profile-1.json`

Kết quả thực nghiệm claim đơn lẻ:
* **Default Profile:** Điểm khả dụng tăng từ 2,413 lên 2,525 (+112 điểm), pending 112 -> 0. Thẻ cập nhật thành `"Ready to claim 0 Claim"`.
* **Profile 1:** Điểm khả dụng tăng từ 3,351 lên 3,363 (+12 điểm), pending 12 -> 0. Thẻ cập nhật thành `"Ready to claim 0 Claim"`.
* Cả 2 tài khoản đã ghi nhận marker tệp để ngăn chặn việc gửi lại request claim (không replay).

#### B. Giai đoạn Kiểm chứng Chỉ đọc Cuối cùng (Mã nguồn mới SHA256 `4e429271...` ngày 26/10)
Bằng chứng lưu tại:
* `/tmp/edge-bing-live-20261025-gp7SPA/final-source-verifier-4e4292.log` (và các bản trước `0b4862b2...`, `b99fcb02...`, `ee790f...`)

Khi mã nguồn `background.js` và verifier được cập nhật đầy đủ (lặp qua allButtons tiếp tục sau thẻ 0 điểm, chuẩn hóa predicate `isSingleActivity` xử lý đúng `findRewardCardRoots` descendants và loại trừ major sections / multi-card wrappers, bảo toàn directCard cho điểm riêng, chặn số 0 dính liền nhãn qua `!/\d/`, lọc bỏ controls/chrome khỏi số lượng thẻ dashboard và so khớp cardinality chặt chẽ), script kiểm chứng thực tế `tests/verify-dual-profile-live.mjs` đã được chạy lại ở chế độ **hoàn toàn chỉ đọc (read-only)** trên cả 2 bản clone cô lập mới vào lúc **13:38 - 13:39 VN (06:38 - 06:39 UTC) ngày 26/10/2026**:
* Extension reload thành công trên clone, worker ID thay đổi, hash SHA256 `4e429271074630ee2c9feb47dcfbd389f1d1afcafc2254cb3cda0ab9fe02095e` được đối soát khớp với repo.
* Cả 2 Profile đều hoàn thành **3/3 thẻ DailySet** (`Global_DailySet_20261026_Child1/2/3`), cardCount 3, và script verifier thoát thành công với mã **Exit 0**.
* Trạng thái trước claim: Cả 2 profile đều hiển thị `"Ready to claim 3 Claim"` (pending = 3 điểm).

#### Bảng tổng hợp đối soát 2 Profile tại lần chạy chỉ đọc cuối cùng (Snapshot 13:38 - 13:39 VN 26/10/2026):

| Tiêu chí | Profile Default (`Default`) | Profile 1 (`Profile 1`) |
| :--- | :--- | :--- |
| **Môi trường chạy** | Clone cô lập (`0700`), Virtual Display Xvfb | Clone cô lập (`0700`), Virtual Display Xvfb |
| **Xác thực tài khoản** | Thành công (`authenticated: true`) | Thành công (`authenticated: true`) |
| **Giao diện Dashboard** | Native React (`#dailyset`), cardCount: 3 | Phục hồi `#ext-restored-dailyset`, cardCount: 3 |
| **Extension Reload** | Worker ID thay đổi (`verified: true`) | Worker ID thay đổi (`verified: true`) |
| **Khớp SHA256 runtime** | `4e429271...` & `d6a785...` khớp chính xác repo | `4e429271...` & `d6a785...` khớp chính xác repo |
| **Daily Set (10/26/2026)** | 3/3 thẻ hoàn thành (`complete: true`) | 3/3 thẻ hoàn thành (`complete: true`) |
| **Streak ngày** | 317 ngày | 132 ngày |
| **Số dư khả dụng** | 2,594 điểm | 3,402 điểm |
| **Trạng thái thẻ claim** | `"Ready to claim 3 Claim"` (pending: 3) | `"Ready to claim 3 Claim"` (pending: 3) |
| **Đánh giá Verifier** | `complete` (3/3 thẻ hoàn thành) | `complete` (3/3 thẻ hoàn thành) |
| **Mã thoát Verifier** | **Exit 0** | **Exit 0** |

> [!NOTE]
> **Ghi nhận lịch sử (HISTORICAL): Lần chạy chưa hoàn tất trước đó**  
> Trong lần chạy chỉ đọc ban đầu vào sáng ngày 26/10/2026, Profile Default có trạng thái `incomplete` (0/3 thẻ hoàn thành) và verifier trả về Exit 1 theo cơ chế fail-closed. Trạng thái này được phân loại là **LỊCH SỬ (HISTORICAL)**, đã được thay thế trọn vẹn bởi kết quả snapshot Exit 0 (3/3 thẻ hoàn thành trên cả 2 profile) vào lúc 13:38 - 13:39 VN cùng ngày.

> [!IMPORTANT]
> **Phân biệt phạm vi Reload Extension:**
> Việc kiểm chứng reload extension được thực hiện trực tiếp trên các tiến trình Chrome chạy clone cô lập trong môi trường Virtual Display. Trình duyệt Chrome foreground đang chạy bình thường của người dùng **không** bị khởi động lại hay reload service worker.

> [!NOTE]
> **Lưu ý về số dư Default (2,594 điểm) và Profile 1 (3,402 điểm):**
> Các mức số dư trước claim ngày 26/10 (2,594 điểm ở Default và 3,402 điểm ở Profile 1) khác biệt so với số dư sau claim ngày 25/10 (2,525 và 3,363 điểm); phần điểm dôi dư phát sinh giữa các phiên này không được quy kết bừa bãi (unexplained extra balances NOT attributed). Bằng chứng claim lịch sử (+112 điểm Default, +12 điểm Profile 1 ngày 25/10) được lưu giữ riêng biệt.

#### C. Bằng chứng Targeted Claim Trực tiếp Ngày 26/10/2026 (Mã nguồn SHA256 `4e429271...`)
Bằng chứng lưu tại:
* `/tmp/edge-bing-live-20261025-gp7SPA/targeted-claim-20261026.log` & `targeted-claim-20261026.json`
* `/tmp/edge-bing-live-20261025-gp7SPA/claim-started-20261026-Default.json` & `claim-started-20261026-Profile-1.json`
* Script probe thực thi: `/tmp/edge-bing-live-20261025-gp7SPA/claim-20261026-4e4292.mjs`

Đợt targeted live claim được thực hiện một lần duy nhất cho mỗi profile trên mã nguồn mới `4e429271...` với cơ chế kiểm soát nghiêm ngặt:
1. Tạo exclusive marker `claim-started-20261026-Default.json` và `claim-started-20261026-Profile-1.json` **trước** khi thực hiện bất kỳ thao tác click claim nào.
2. Kiểm tra xác thực (`authenticated: true`), đúng ngày hiện tại (`10/26/2026`), hash SHA256 mã nguồn và pending chính xác bằng 3.
3. Kích hoạt đúng nút claim mục tiêu từ mã nguồn tiêm hiện tại một lần duy nhất (không chạy scheduler, không tìm kiếm, không đổi quà).
4. Tải lại flyout và dashboard độc lập sau claim để xác minh số dư và trạng thái pending.

**Kết quả thực nghiệm:**
* **Profile Default:**
  - Số dư khả dụng: Tăng từ 2,594 lên 2,597 điểm (**delta chính xác +3 điểm**).
  - Trạng thái pending: Chuyển từ 3 về 0 (`"Ready to claim 0 Claim"`).
  - Kết quả: `success: true`.
* **Profile 1:**
  - Số dư khả dụng: Tăng from 3,402 lên 3,405 điểm (**delta chính xác +3 điểm**).
  - Trạng thái pending: Chuyển từ 3 về 0 (`"Ready to claim 0 Claim"`).
  - Kết quả: `success: true`.
* **Bảo vệ môi trường & Không replay:** Các marker `claim-started-20261026-*.json` được lưu giữ để ngăn chặn mọi hành vi replay. Các bản sao lưu SQLite Cookies chỉ đọc và thư mục tạm đã được dọn dẹp sạch sẽ sau khi hoàn tất.

#### D. Bằng chứng Kiểm chứng Chỉ đọc Sau Claim (Snapshot Fresh Read lúc 18:41 VN / 11:41 UTC ngày 26/10/2026)

Sau khi hoàn tất đợt targeted claim trong ngày và áp dụng các bản vá chẩn đoán locale `readyCards` cùng URI an toàn `pathlib.Path(...).as_uri() + '?mode=ro'`, script kiểm chứng chỉ đọc `tests/verify-dual-profile-live.mjs` đã được chạy lại độc lập qua Virtual Display Xvfb:
* **Profile Default (Native React `#dailyset`):** Thẻ DailySet 3/3 (`Global_DailySet_20261026_Child1/2/3`) hoàn thành (`complete: true`), `cardCount: 3`, điểm khả dụng 2,597, streak 317 ngày, trạng thái thẻ chẩn đoán `readyCards: ["Ready to claim 0 Claim"]` (xác nhận pending = 0, không click thừa), assessment `complete`, thoát **Exit 0**.
* **Profile 1 (Phục hồi `#ext-restored-dailyset`):** Thẻ DailySet 3/3 (`Global_DailySet_20261026_Child1/2/3`) hoàn thành (`complete: true`), `cardCount: 3`, điểm khả dụng 3,405, streak 132 ngày, trạng thái thẻ chẩn đoán `readyCards: ["Ready to claim 0 Claim"]` (xác nhận pending = 0, không click thừa), assessment `complete`, thoát **Exit 0**.
* **Mã thoát Verifier:** **Exit 0** (Cả 2 profile đều đạt `complete` 3/3 thẻ).

---

## 5. Quy Trình Vận Hành Chuẩn Cho Các Phiên Tương Lai (Safe Repeatable Commands)

### 5.1. Chạy toàn bộ test tự động của dự án
```bash
./tests/run-all-tests.sh
```

### 5.2. Chạy kiểm thử trực tiếp 2 profile qua Virtual Display
Không chạy trực tiếp trên desktop của người dùng. Luôn luôn sử dụng wrapper Xvfb:
```bash
/u01/workspace/FacebookBot/scripts/run-with-virtual-display.sh env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_CURRENT_DESKTOP=GNOME node tests/verify-dual-profile-live.mjs
```

### 5.3. Các lưu ý bảo vệ môi trường vận hành
1. **Không sử dụng các đường dẫn thư mục tạm cố định** như `/tmp/chrome-test-p1` hay `/tmp/chrome-test-default`. Script tự động sinh thư mục ngẫu nhiên và dọn dẹp sạch sẽ sau khi kiểm tra xong.
2. **Không chạy lệnh `kill -9` hoặc `pkill` diện rộng** đối với trình duyệt Chrome của người dùng.
3. **Không replay lại các thao tác claim đã hoàn thành** để tránh gửi request dư thừa lên server Microsoft Rewards.

---

## 6. Phạm Vi Giới Hạn & Những Gì Đã Bỏ Qua (Known Limits & Non-Goals)

1. **Chưa chạy toàn trình Scheduler E2E:** Quá trình kiểm thử thực tế chỉ kiểm chứng targeted claim đơn lẻ và trạng thái flyout/dashboard. Chu trình scheduler tự động đầy đủ (tạo alarm, tìm kiếm Bing ngẫu nhiên theo lịch, cạn kiệt quota tìm kiếm) không được kích hoạt trên tài khoản thật trong phiên này để tránh tác động phụ.
2. **Không can thiệp cơ chế độc quyền app:** Không mở rộng mã nguồn ngoài phạm vi cho các cơ chế app-exclusive chưa cần thiết.
