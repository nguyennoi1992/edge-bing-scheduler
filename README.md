# Edge Bing Scheduler

An automation extension for Microsoft Edge that helps you **complete Bing Rewards activities** and **run scheduled Bing searches** with random intervals.

---

## ✨ Features

* ⏰ **Daily Scheduler**

    * Configure a specific time to run every day (HH:MM, 24-hour format)
    * Manual **Run Now** option

* 🎁 **Bing Rewards Auto-Click**

    * Automatically opens `rewards.bing.com`
    * Clicks all **uncompleted activity cards** (Daily set, More activities)
    * Skips completed cards automatically

* 🔍 **Bing Search Automation**

    * Performs Bing searches after Rewards tasks finish
    * Uses random words/phrases or custom queries
    * Random delay between searches (min / max seconds)

* ⚙️ **Configurable UI**

    * Enable / disable extension
    * Set schedule time
    * Set number of searches per run
    * Set random interval range
    * Add custom search queries

---

## 📂 Project Structure

```
edge-bing-scheduler/
├─ manifest.json
├─ background.js
├─ reward-dom-helpers.js
├─ reward-scanner-helpers.js
├─ script-result-helpers.js
├─ words.js
├─ popup.html
├─ popup.js
├─ options.html
├─ options.js
├─ docs/
└─ tests/
```

---

## 🧠 How It Works

1. At the scheduled time (or when clicking **Run Now**):

    * Opens `https://rewards.bing.com`
    * Automatically clicks all available, uncompleted Rewards cards
2. After Rewards tasks finish:

    * Starts Bing searches
    * Each search opens with a **random delay** between tabs
3. Stops automatically after completing all configured searches

---

## ⚙️ Configuration

Open **Options** page:

* **Enable**: Turn automation on/off
* **Run time**: Daily execution time (HH:MM)
* **Searches per run**: Number of Bing searches
* **Interval Min / Max**: Random delay between searches (seconds)
* **Custom queries**:

    * Newline or comma separated
    * If empty, random words are used

---

## 🔐 Permissions Used

* `tabs` – open and control Bing / Rewards tabs
* `scripting` – inject scripts to automate actions
* `alarms` – schedule daily execution
* `storage` – save user settings
* `host_permissions`:

    * `https://*.bing.com/*`
    * `https://rewards.bing.com/*`

---

## 🚀 Installation (Developer Mode)

1. Open `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `edge-bing-scheduler` folder

---

## 📚 Documentation & Technical Guides

Tất cả tài liệu kỹ thuật, kiến trúc và quy trình kiểm thử được tổ chức trong thư mục `docs/`:

* 📖 [**Multi-Profile Testing & Verification Guide**](docs/MULTI_PROFILE_TESTING_AND_VERIFICATION_GUIDE.md)  
  Quy trình chuẩn rà soát, sao chép profile an toàn, chạy kiểm thử qua virtual display (`Xvfb`), xác nhận hoàn thành thẻ (`complete: true`) trên backend Microsoft Rewards.
* 🛠️ [**Verification & Claim Fix: Dual-Profile Live (2026-10-25 - 2026-10-26)**](docs/verification-and-claim-fix-2026-10-25-dual-profile-live.md)
  Báo cáo kỹ thuật chi tiết ngày 25/10 - 26/10/2026: Sửa lỗi claim thẻ 0 điểm ("Ready to claim 0 Claim"), đồng bộ regex MAIN-world, kiểm chứng reload extension, kết quả verifier 3/3 thẻ exit 0 và targeted claim proof thành công trên cả 2 profile.
* 🔍 [**Investigation & Fix: Flight `vsstreak` & Card Completion**](docs/investigation-and-fix-2026-10-15-dashboard-cards-and-profile1-streak.md)  
  Báo cáo chuyên sâu về flighting `vsstreak`, cơ chế phục hồi `#ext-restored-dailyset`, endpoint `/msrewards/api/v1/reportactivity` và kiểm chứng đa profile.
* ⚡ [**Rewards Hydration & Scanning Optimization**](docs/optimization-2026-10-12-rewards-hydration-scheduler.md)  
  Kiến trúc quét DOM, phát hiện trạng thái hydration và phân loại section an toàn.
* 🛡️ [**Edge Rewards Scripting Protected Page Handling**](docs/bugfix-2026-08-22-edge-rewards-scripting-blocked.md)  
  Xử lý ngoại lệ chính sách bảo vệ trang của Microsoft Edge.

---

## Browser Tests

Run the complete Node (32 tests), syntax, manifest, and Microsoft Edge test suite:

```bash
tests/run-all-tests.sh
```

Run only the isolated `earn`, hydration/timeout, and `dashboard` DOM tests in Microsoft Edge:

```bash
tests/run-browser-tests.sh
```

The tests use local fixtures and do not click activities on a live Rewards account.

---

## ⚠️ Notes

* No login credentials are stored or required
* No third-party services are used
* Works only when Bing Rewards layout is available
* UI and selectors may change if Microsoft updates Rewards pages

---

## 📜 License

For personal and educational use.
