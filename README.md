# Bot tự động trả lời fanpage HikariGo

Bot nhận tin nhắn từ fanpage qua Meta Messenger Platform, trả lời theo
FAQ có sẵn (`knowledge.json`), và dùng AI cho câu hỏi ngoài FAQ (nếu cấu hình).

## Cách bot trả lời

1. Khách nhắc "nhân viên / người thật..." → bot báo đã chuyển cho nhân viên.
2. Khớp từ khóa trong FAQ → trả lời mẫu có sẵn (miễn phí, chính xác).
3. Không khớp FAQ → gọi AI (cần `LLM_API_URL` + `LLM_API_KEY`).
   AI được nạp toàn bộ FAQ vào prompt nên có thể **tự suy luận** trả lời
   các câu hỏi mới dựa trên dữ liệu thật của page; khi không chắc chắn,
   AI sẽ tự thêm câu hẹn chuyển cho nhân viên xác nhận.
4. Không có AI → gửi câu `fallback` trong `knowledge.json`.

Các mục `[CẦN BỔ SUNG]` trong `knowledge.json` là thông tin riêng của
HikariGo (bảng giá, thời gian vận chuyển, hotline...) — điền vào trước khi chạy thật.

## Bước 1 — Tạo Meta App

1. Vào https://developers.facebook.com/apps → Create App → loại **Business**.
2. Trong App Dashboard → Add Product → **Messenger** → Set up.
3. Trong Messenger settings → Access Tokens → chọn Page **HikariGo** → Generate Token.
   Quyền cần xin: `pages_messaging` (gửi/nhận tin nhắn), `pages_manage_metadata`.
4. Lưu **Page Access Token** và **App Secret** (Settings → Basic).

## Bước 2 — Deploy code

Đưa thư mục này lên host công khai. Cách nhanh nhất: Render (có sẵn `render.yaml` và `Dockerfile`):

1. Đẩy thư mục này lên một repo GitHub riêng.
2. Vào https://dashboard.render.com → New → Blueprint → chọn repo → Apply.
3. Trong Environment, điền: `PAGE_ACCESS_TOKEN`, `APP_SECRET` (lấy ở Bước 1),
   `VERIFY_TOKEN` (tự đặt một chuỗi bí mật, sẽ dùng ở Bước 3),
   và `LLM_API_URL` + `LLM_API_KEY` + `LLM_MODEL` nếu dùng AI.
4. Deploy xong, kiểm tra `https://<ten-service>.onrender.com/health` → thấy chữ `ok`.

Cách thủ công (Railway / Fly.io / VPS bất kỳ):

```bash
npm install
npm start
```

Cấu hình biến môi trường theo `.env.example`:
`PAGE_ACCESS_TOKEN`, `VERIFY_TOKEN`, `APP_SECRET` (+ LLM nếu dùng AI).

## Bước 3 — Cài webhook cho Page

1. Trong Messenger settings → Webhooks → Add Callback URL:
   - Callback URL: `https://<host-cua-ban>/webhook`
   - Verify token: đúng `VERIFY_TOKEN` đã cấu hình → Verify and Save.
2. Trong Webhook fields → Subscribe: tích **messages** (và **messaging_postbacks** nếu cần).
3. Trong Access Tokens → chọn Page HikariGo → Subscribe to webhook events cho Page.

## Bước 4 — App Review (bắt buộc để chạy với khách thật)

Ở chế độ Development, bot chỉ trả lời được cho admin/tester của app.
Để trả lời mọi khách nhắn page: App Review → xin quyền **pages_messaging**,
gửi kèm video demo bot hoạt động. Meta thường duyệt trong vài ngày.

## Kiểm thử

- Nhắn tin vào page bằng tài khoản tester → bot phải trả lời theo FAQ.
- Nhắn từ khóa "nhân viên" → bot báo chuyển cho nhân viên.
- Nhắn câu ngoài FAQ → bot dùng AI (nếu cấu hình) hoặc gửi câu fallback.
