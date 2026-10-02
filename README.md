# viber-context

Plugin Claude Code **dùng nội bộ**, chỉ cài từ thư mục này trên máy. Không push, không đăng marketplace công khai.

Làm cho `vibervn-context-engine` chạy trên máy hoạt động giống Augment: mỗi phiên Claude Code tự lo engine và chỉ mục, Claude có công cụ truy xuất codebase và được dặn khi nào nên dùng.

## Mỗi phiên làm gì

1. Lấy gốc dự án (`git rev-parse --show-toplevel`, không có git thì dùng thư mục hiện tại). Bỏ qua hẳn nếu là thư mục home hoặc gốc ổ đĩa.
2. Nếu engine (`http://127.0.0.1:6699`) chưa trả lời thì khởi động nền `vibervn-context-engine --port 6699`, chờ tối đa 20 giây. Đang chạy thì không đụng.
3. Chưa có trong `repos` của engine thì thêm vào qua `PUT /api/config` (giữ nguyên mọi trường khác, không bao giờ xoá repo).
4. Gọi lập chỉ mục tăng dần một lần, theo dõi mỗi 3 giây (tối đa 10 phút).
5. Dòng trạng thái (đọc `state`, `phase`, `indexed_files`, `total_files` từ engine, không bao giờ hiện `0/0`):
   - **Lần đầu** (repo chưa có `last_indexed_at` hoặc 0 file): `ctx ◌ đang bật engine…` → `ctx ◌ lần đầu lập chỉ mục · đang quét file…` → `ctx ◌ lập chỉ mục ▰▰▰▱▱▱▱▱▱▱ 32% · 347/1.084 file · còn ~1m 20s` (ETA tính từ tốc độ giữa các lần lấy mẫu, chưa có thì bỏ) → `ctx ◌ nối quan hệ gọi hàm…` → dòng sẵn sàng, kèm một toast `✓ viber-context: đã lập chỉ mục 1.084 file trong 2m 14s`. Phase lạ hoặc `symbol_index` hiện `ctx ◌ lập chỉ mục…`.
   - **Các lần sau**: `ctx ◌ kiểm tra thay đổi…`, nếu engine đang xử lý file đã đổi thì `ctx ◌ cập nhật N file đã đổi…`, rồi dòng sẵn sàng. Không thanh tiến độ, không toast. Xong là dừng theo dõi nên sửa file trong lúc làm việc không đổi dòng này (engine tự lập chỉ mục lại âm thầm).
   - **Sẵn sàng**: `ctx ● 1.234 file · còn 8 search · 15 ngày`. Có `⚠` ở đầu khi còn ≤ 5% (hoặc ≤ 50) lượt search hoặc ≤ 3 ngày; `ctx ✗ hết lượt search` hoặc `ctx ✗ gói đã hết hạn` khi hết. Toast một lần mỗi phiên khi chuyển sang cảnh báo hoặc hết.
   - Quá 10 phút chưa xong: giữ số liệu gói và thêm `· chỉ mục chưa xong (/ctx reindex)`.

## Công cụ cho Claude

- `mcp__viber-context__codebase_retrieval`: hỏi bằng ngôn ngữ tự nhiên "ở đâu / làm thế nào" về codebase; lọc tuỳ chọn `filter_kind`, `filter_lang`, `filter_path`.
- `mcp__viber-context__file_retrieval`: biết file rồi nhưng chưa biết dòng nào.

Phần dặn trong system prompt (tiếng Anh) bảo Claude gọi retrieval trước khi đọc nhiều file, dùng Grep cho chuỗi chính xác, và tránh truy vấn lặp vì mỗi lượt search tính vào gói. Hết lượt hoặc hết hạn thì công cụ trả lời ngay (không gọi engine) và prompt báo retrieval không dùng được.

## Thẻ kết quả trong hội thoại

Mỗi lần gọi `codebase_retrieval` / `file_retrieval` hiện một thẻ (chữ trên thẻ bằng tiếng Anh, cùng kiểu thẻ của plugin acp-ui): `✓ ◎ Retrieval <câu hỏi>` và bên phải `4 chunks · 0.8s`; tối đa 4 dòng kết quả `đường/dẫn#L10-24`, dòng code đầu của khối, `← nơi gọi`, `→ hàm được gọi` (đọc từ chính văn bản engine trả về, không đọc được thì không có dòng nào); cuối thẻ `9,991 searches left` (`⚠` màu vàng khi sắp hết). Đang chạy thẻ nền xanh với `◌`. Gọi bị bỏ qua vì hết lượt hoặc hết hạn thì `✗ ... skipped` kèm gợi ý dùng Grep / Read. Dòng kết quả thô bên dưới được ẩn (Claude vẫn nhận đủ văn bản); lỗi vẫn hiện như thường.

## Lệnh

- `/ctx`: engine, gốc dự án, đăng ký, chỉ mục, và khối **Gói dịch vụ** (tên gói, hạn, hai thanh Embeddings và Search). Không bao giờ in key hay invoice.
- `/ctx goi`: chỉ khối gói.
- `/ctx reindex`: lập chỉ mục lại ngay.
- `/ctx off` / `/ctx on`: tắt hoặc bật tự lập chỉ mục và truy xuất cho dự án này (nhớ theo từng gốc dự án).

Số liệu gói đọc từ `GET /api/plan/usage` của engine, làm mới khi bắt đầu phiên, sau mỗi lần truy xuất và mỗi 10 phút. Plugin không gọi bất kỳ endpoint thanh toán nào và không sửa dữ liệu gói.

## Cài

```sh
claude plugin marketplace add "E:\Dev\www\viber-context"
claude plugin install viber-context@viber-context-local
```

Sửa xong thì nâng `version` trong `plugin/.claude-plugin/plugin.json` và `.claude-plugin/marketplace.json`, rồi:

```sh
claude plugin marketplace update viber-context-local
claude plugin update viber-context@viber-context-local
```

## Kiểm tra

```sh
claude plugin validate plugin
claude plugin validate .
claude plugin test plugin
```

Test chỉ dùng mock (không mạng thật, không tiến trình thật).
