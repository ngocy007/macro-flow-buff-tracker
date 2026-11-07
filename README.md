# Trợ thủ Buff

Ứng dụng Windows (Tauri 2) theo dõi buff trên màn hình game, đếm hồi chiêu và báo bằng giọng nói. Có thêm hẹn giờ thủ công và macro phím (tùy chọn).

## Tính năng

- **Theo dõi buff:** nhận diện icon buff trên hình game, đếm hiệu lực / hồi chiêu, đọc 5-4-3-2-1 và báo khi sẵn sàng. Hiện số đếm trên cửa sổ nổi phía trên game.
- **Hẹn giờ:** gán một phím, bấm trong game là bắt đầu đếm ngược số giây bạn đặt, hiện trên cửa sổ nổi và báo khi hết giờ.
- **Macro:** ghi hoặc soạn chuỗi phím / click chuột, gán phím tắt để chạy.

## Trợ thủ Buff làm gì với game

Phần **theo dõi buff** chỉ nhìn hình. App chụp hình cửa sổ game (bằng `PrintWindow` hoặc `BitBlt`, cùng loại API các công cụ chụp màn hình dùng), so khớp icon buff ngay trên máy, rồi đếm hồi chiêu theo thời gian bạn đã cài và phát giọng đọc WAV cục bộ. Phần này không đọc hay ghi bộ nhớ game, không tiêm mã, không sửa file game, không can thiệp gói tin mạng, và không gửi hình hay kết quả đi đâu.

Hai tính năng **tùy chọn** sẽ tương tác với bàn phím:

- **Hẹn giờ:** dùng hook bàn phím cấp thấp của Windows để biết khi bạn bấm phím đã gán. Hook chỉ nghe, không chặn và không đổi phím.
- **Macro:** gửi phím và click chuột vào game bằng `SendInput`. Đây là giả lập thao tác. Nhiều game cấm macro, hãy đọc kỹ luật của game trước khi dùng.

Nếu không tạo hẹn giờ hay macro nào, app không gán phím nào ngoài phím bật/tắt theo dõi (nếu bạn đặt).

**Mạng:** app không gửi dữ liệu đi đâu. Giao diện chỉ tải font từ Google Fonts; khi không có mạng thì dùng font hệ thống.

**Quyền Admin:** nếu game chạy bằng quyền Admin thì app cũng phải chạy bằng quyền Admin, nếu không phím tắt, hẹn giờ và macro sẽ không hoạt động trong game.

## Chạy từ mã nguồn

Cần Rust (stable) trên Windows.

```bash
cd src-tauri
cargo run
```

Giao diện nằm trong `ui/` (HTML/CSS/JS thuần, không cần build). Cấu hình và âm thanh của người dùng được lưu trong thư mục dữ liệu của app (`buff-assistant/`).
