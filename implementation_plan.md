# Tối ưu dashboard reward-card scan

## Kết luận nguyên nhân

Logs cho thấy dashboard mất nhiều thời gian sau khi các Daily Set cards đã được xử lý. Có hai nguyên nhân trong code:

1. `waitForRewardsDomReady()` và `getRewardCards()` chỉ kết thúc sớm khi tìm thấy card. Khi section đã load xong nhưng không còn card hợp lệ, hai hàm lần lượt chờ tới 45 giây và 30 giây.
2. Bộ lọc dashboard fallback không nhất quán. DOM-ready check chỉ chấp nhận earning URLs, nhưng card scanner đưa mọi rounded anchor vào fallback. Vì vậy `/redeem` và `/redeem/...shop` xuất hiện trong diagnostics dù chúng là navigation links, không phải reward activities.

`isVisible()` không kiểm tra element có nằm trong viewport hay không. Element ngoài viewport vẫn có thể có `width` và `height` dương, nên scroll không phải cách sửa phù hợp cho các diagnostics `not_visible` này.

## Implementation

### 1. Dùng chung bộ lọc earning URL

- Thêm `isDashboardRewardHref()` vào `reward-dom-helpers.js` và inject vào MAIN world.
- Áp dụng bộ lọc cho cả rounded anchors và React Aria pressable anchors.
- Loại `/redeem`, shop và các navigation links khỏi dashboard fallback trước khi đánh giá visibility/actionability.

### 2. Kết thúc sớm khi section ổn định nhưng rỗng

- Thêm `shouldFinishEmptyRewardScan()` với các điều kiện:
  - `document.readyState === "complete"`;
  - ít nhất một target section tồn tại;
  - card count bằng `0`;
  - trạng thái rỗng ổn định trong 5 poll liên tiếp.
- Áp dụng cho cả `waitForRewardsDomReady()` và `getRewardCards()`.
- Giữ timeout đầy đủ nếu target section chưa xuất hiện để không che lỗi load trang hoặc thay đổi DOM.

### 3. Giảm wait sau lần discovery đầu tiên

- Dashboard dùng timeout 45 giây cho discovery đầu tiên.
- Sau khi đã từng tìm thấy card, timeout tối đa giảm còn 15 giây.
- Khi phải dùng một previously discovered card, vòng kế tiếp bỏ qua DOM-ready wait nhưng vẫn chạy card scan để xác nhận trạng thái mới.

## Hiệu quả dự kiến

| Trạng thái | Trước | Sau |
|---|---:|---:|
| Section tồn tại, không còn card | tối đa khoảng 75 giây | khoảng 14 giây |
| Có card ổn định | khoảng 3 giây/card scan | không đổi |
| Section không xuất hiện | giữ timeout an toàn | giữ timeout an toàn |
| `/redeem` và shop bị click | có thể lọt qua fallback | bị loại trước khi scan |

## Verification

### Automated

- `node --experimental-default-type=module --check background.js`
- `node --experimental-default-type=module --check reward-dom-helpers.js`
- `node --experimental-default-type=module tests/reward-dom-helpers.test.mjs`
- `git diff --check`

Unit tests xác nhận:

- earning activity URLs được chấp nhận;
- `/redeem` và shop bị từ chối;
- stable-empty chỉ kết thúc khi document và target section đã sẵn sàng;
- threshold số poll hoạt động đúng.

### Manual

- Chạy lại trên hai Edge profiles.
- Xác nhận diagnostics có `reason="stable_empty"` khi không còn card.
- Xác nhận không click hoặc mở child tab cho `/redeem` và shop.
- Xác nhận Daily Set và More Activities hợp lệ vẫn được click đầy đủ.
