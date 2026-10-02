# viber-context

Plugin Claude Code **dùng nội bộ**, chỉ cài từ thư mục này trên máy. Không push, không đăng marketplace công khai.

Làm cho `vibervn-context-engine` chạy trên máy hoạt động giống Augment: mỗi phiên Claude Code tự lo engine và chỉ mục, Claude có công cụ truy xuất codebase và được dặn khi nào nên dùng.

## Mỗi phiên làm gì

1. Lấy gốc dự án (`git rev-parse --show-toplevel`, không có git thì dùng thư mục hiện tại). Bỏ qua hẳn nếu là thư mục home hoặc gốc ổ đĩa.
2. Nếu engine (`http://127.0.0.1:6699`) chưa trả lời thì khởi động nền `vibervn-context-engine --port 6699`, chờ tối đa 20 giây. Đang chạy thì không đụng.
3. Chưa có trong `repos` của engine thì thêm vào qua `PUT /api/config` (giữ nguyên mọi trường khác, không bao giờ xoá repo).
4. Gọi lập chỉ mục tăng dần một lần, theo dõi mỗi 3 giây (tối đa 10 phút).
5. Dòng trạng thái: `ctx ◌ lập chỉ mục 40/120`, rồi `ctx ● 1.234 file · còn 8 search · 15 ngày`. Có `⚠` ở đầu khi còn ≤ 5% (hoặc ≤ 50) lượt search hoặc ≤ 3 ngày; `ctx ✗ hết lượt search` hoặc `ctx ✗ gói đã hết hạn` khi hết. Toast một lần mỗi phiên khi chuyển sang cảnh báo hoặc hết.

## Công cụ cho Claude

- `mcp__viber-context__codebase_retrieval`: hỏi bằng ngôn ngữ tự nhiên "ở đâu / làm thế nào" về codebase; lọc tuỳ chọn `filter_kind`, `filter_lang`, `filter_path`.
- `mcp__viber-context__file_retrieval`: biết file rồi nhưng chưa biết dòng nào.

Phần dặn trong system prompt (tiếng Anh) bảo Claude gọi retrieval trước khi đọc nhiều file, dùng Grep cho chuỗi chính xác, và tránh truy vấn lặp vì mỗi lượt search tính vào gói. Hết lượt hoặc hết hạn thì công cụ trả lời ngay (không gọi engine) và prompt báo retrieval không dùng được.

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
