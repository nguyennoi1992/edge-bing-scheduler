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
├─ words.js
├─ popup.html
├─ popup.js
├─ options.html
└─ options.js
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

## ⚠️ Notes

* No login credentials are stored or required
* No third-party services are used
* Works only when Bing Rewards layout is available
* UI and selectors may change if Microsoft updates Rewards pages

---

## 📜 License

For personal and educational use.