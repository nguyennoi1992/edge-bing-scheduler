# Scheduler với Profile Slot tùy chọn

## Tóm tắt

- Bổ sung `Profile Slot` để người dùng chủ động rải thời gian chạy giữa nhiều Edge profile.
- Không yêu cầu khai báo tổng số profile và không tự phát hiện profile khác.
- Slot để trống hoặc bằng `0` giữ nguyên hành vi cũ.
- Mỗi slot kế tiếp trễ thêm 10 phút, không dùng random jitter.
- Loại bỏ cơ chế tự kiểm tra internet định kỳ từ 01:00 đến 05:00 để tránh phát sinh nhiều nguồn khởi chạy trùng nhau.

## Cấu hình và Options

- `profileSlot` được lưu trong `chrome.storage.local`, tách biệt với cấu hình đồng bộ của từng profile.
- Giá trị hợp lệ từ `1` đến `100`; giá trị trống, `0`, âm, không phải số hoặc vượt giới hạn được chuẩn hóa thành `0`.
- Quy tắc offset: slot `N` trễ `(N - 1) × 10` phút.
- Options hiển thị preview giờ chạy sau khi cộng offset và báo nếu lịch chuyển sang ngày kế tiếp.
- Các cấu hình hiện tại tiếp tục được lưu trong `chrome.storage.sync`.

## Scheduler và Internet Retry

- Lịch hằng ngày cộng slot offset trước khi xác định lần chạy tiếp theo và lưu thời điểm cuối vào `nextRunAt`.
- `RUN_NOW` luôn chạy ngay, không áp dụng slot.
- Nếu một lần chạy thất bại vì mất mạng, `internetRetry` tiếp tục kiểm tra lại theo chu kỳ hiện có.
- Khi mạng phục hồi, profile không có offset chạy ngay; profile có slot lớn hơn `1` tạo `delayedStartRun` theo đúng offset.
- Chỉ duy trì một delayed alarm; alarm được xóa khi disable, đổi cấu hình, reschedule hoặc hoàn tất một lần chạy.
- Service worker restart không chủ động xóa delayed alarm đang chờ.
- Không còn `earlyInternetCheck`, khung kiểm tra 01:00–05:00 hoặc nhánh tự chạy từ early check.

## Kiểm thử

- Không cấu hình slot và slot `1` chạy đúng giờ cấu hình.
- Slot `2` trễ 10 phút; slot `5` trễ 40 phút.
- Lịch vẫn chọn đúng ngày khi base time đã qua nhưng thời điểm sau offset chưa qua, kể cả offset vượt qua nửa đêm.
- Internet retry không tạo nhiều delayed alarm cho cùng profile.
- Reload service worker giữ delayed alarm đang chờ.
- Disable hoặc thay đổi slot xóa delayed alarm cũ và tính lại lịch.
- Xác nhận không còn symbol hoặc alarm liên quan đến early internet check.
- Chạy `node --check` cho JavaScript và `git diff --check`.

## Giả định

- Người dùng tự bảo đảm mỗi profile dùng một slot khác nhau.
- Các profile không cấu hình slot vẫn có thể chạy đồng thời như phiên bản cũ.
- Khoảng cách slot cố định là 10 phút.
