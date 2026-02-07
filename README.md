# WebChatLocalLan (Python)

Webapp chat nội bộ LAN, không cần đăng nhập:
- Tự nhận diện người dùng theo IP.
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

Mặc định app chạy tại `http://0.0.0.0:8000`.

## 2) Biến môi trường

- `WEBCHAT_HOST` (mặc định `0.0.0.0`)
- `WEBCHAT_PORT` (mặc định `8000`)
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

## 4) Luồng sử dụng

- Mở web trên các máy cùng LAN.
- Sidebar hiển thị người online theo IP.
- Chọn `# Public` để chat chung.
- Chọn một IP để chat riêng, client sẽ dùng E2EE nếu peer đã có key (`[E2EE]`).
- Form dưới cùng dùng để gửi ảnh/file:
  - Public: gửi bình thường.
  - Private: file được mã hóa phía trình duyệt trước khi upload.
- Mỗi client có fingerprint khóa ở sidebar. Nếu cần xác minh chống giả mạo, đối chiếu fingerprint giữa 2 máy qua kênh khác.

## 5) Đề xuất nâng cao (nên làm tiếp)

1. Đặt tên hiển thị theo máy (lưu localStorage, vẫn giữ IP làm định danh thật).
2. Lưu lịch sử vào SQLite (thay vì RAM) để không mất khi restart.
3. Thêm cơ chế xác minh fingerprint (TOFU + cảnh báo đổi khóa, hoặc QR verify).
4. Chặn MIME/đuôi file nguy hiểm và quét virus.
5. Thông báo desktop (Web Notifications) khi có tin nhắn mới.
