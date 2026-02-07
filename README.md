# WebChatLocalLan (Python)

Webapp chat nội bộ LAN, không cần đăng nhập:
- Tự nhận diện người dùng theo `device_id` (vân tay đơn giản lưu localStorage), vẫn hiển thị IP mạng.
- Xem danh sách ai đang online (đang mở web).
- Chat công khai và chat riêng theo IP.
- Gửi ảnh/file, hiển thị media ngay trong khung chat.
- E2EE cho chat riêng (text + file): server chỉ relay dữ liệu đã mã hóa.
- Chạy được trên Windows (test) và Linux (systemd).

## 1) Cài đặt (dùng uv)

Yêu cầu: Python 3.10+.

### Linux

```bash
chmod +x scripts/setup_linux.sh
./scripts/setup_linux.sh
```

### Windows (PowerShell)

```powershell
.\scripts\setup_windows.ps1
```

Hoặc từ `cmd`:

```bat
scripts\setup_windows.cmd
```

Script setup sẽ:
- Cài `uv` nếu chưa có.
- Chạy `uv sync` để tạo `.venv` và cài dependencies từ `pyproject.toml`.
- Chạy health-check nhanh.

Chạy app:

```bash
uv run python main.py
```

Mặc định app chạy tại `http://0.0.0.0:9098`.

## 2) Biến môi trường

- `WEBCHAT_HOST` (mặc định `0.0.0.0`)
- `WEBCHAT_PORT` (mặc định `9098`)
- `WEBCHAT_UPLOAD_DIR` (mặc định `./uploads`)
- `WEBCHAT_MAX_UPLOAD_MB` (mặc định `25`)
- `WEBCHAT_MAX_HISTORY` (mặc định `500`)
- `WEBCHAT_RELOAD=1` để bật auto-reload khi dev

## 3) Chạy bằng systemd (Linux)

1. Copy project tới ví dụ: `/opt/webchat-local-lan`
2. Chạy setup:

```bash
cd /opt/webchat-local-lan
./scripts/setup_linux.sh
```

3. Kiểm tra lệnh service (không cài):

```bash
python service.py --check
python service.py --print-only
```

4. Cài service:

```bash
python service.py --user www-data
sudo systemctl status webchat-local-lan.service
```

## 4) Không truy cập được từ thiết bị khác (LAN) - kiểm tra nhanh

1. App phải bind `0.0.0.0`, không phải `127.0.0.1`.
   - Với project này mặc định đã là `WEBCHAT_HOST=0.0.0.0`.
2. Dùng đúng IP LAN của máy server, ví dụ `http://192.168.1.20:9098` (không dùng `localhost` từ máy khác).
3. Kiểm tra service/app thật sự đang listen ở `9098`:
   - Linux: `ss -ltnp | grep 9098`
   - Windows: `netstat -ano | findstr :9098`
4. Firewall phải mở inbound TCP `9098` cho profile mạng đang dùng (Private/Public).
5. Hai thiết bị phải cùng subnet và router/AP không bật client isolation / AP isolation.
6. Nếu chạy qua VM/WSL/container, cần mở port/bridge đúng lớp mạng host.

## 5) Luồng sử dụng

- Mở web trên các máy cùng LAN.
- Sidebar hiển thị người online theo thiết bị (kèm `device_id` rút gọn + IP mạng).
- Chọn `# Public` để chat chung.
- Chọn một IP để chat riêng, client sẽ dùng E2EE nếu peer đã có key (`[E2EE]`).
- Form dưới cùng dùng để gửi ảnh/file:
  - Public: gửi bình thường.
  - Private: file được mã hóa phía trình duyệt trước khi upload.
- Mỗi client có fingerprint khóa ở sidebar. Nếu cần xác minh chống giả mạo, đối chiếu fingerprint giữa 2 máy qua kênh khác.

## 6) Ghi chú định danh thiết bị

- Nếu nhiều thiết bị đi qua cùng một router/NAT thì server có thể thấy cùng IP.
- App dùng `device_id` riêng trên từng trình duyệt để tách thiết bị.
- `device_id` được tạo tự động và lưu trong `localStorage`.
- Nếu muốn tạo lại vân tay thiết bị, xóa localStorage key:
  - `webchat_device_profile_v1`
  - (tuỳ chọn) `webchat_e2ee_identity_v1`

## 7) Đề xuất nâng cao (nên làm tiếp)

1. Đặt tên hiển thị theo máy (lưu localStorage, vẫn giữ IP làm định danh thật).
2. Lưu lịch sử vào SQLite (thay vì RAM) để không mất khi restart.
3. Thêm cơ chế xác minh fingerprint (TOFU + cảnh báo đổi khóa, hoặc QR verify).
4. Chặn MIME/đuôi file nguy hiểm và quét virus.
5. Thông báo desktop (Web Notifications) khi có tin nhắn mới.
