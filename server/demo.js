// Dữ liệu giả để chạy thử giao diện mà không cần tài khoản Facebook.
import { all, get, run, setSetting, getSetting } from './db.js';
import * as store from './store.js';
import { handleIncomingComment, handleIncomingMessage } from './autoreply.js';

const NAMES = [
  'Nguyễn Thu Hà', 'Trần Minh Quân', 'Lê Hoàng Anh', 'Phạm Ngọc Linh', 'Võ Thanh Tùng', 'Đặng Mai Phương',
  'Bùi Đức Thắng', 'Hoàng Thị Lan', 'Đỗ Quang Huy', 'Ngô Bảo Châu', 'Dương Khánh Vy', 'Lý Gia Bảo',
];

const CUSTOMER_LINES = [
  'Chào shop, mẫu áo này còn size M không ạ?',
  'Giá bao nhiêu vậy shop?',
  'Mình ở Đà Nẵng thì phí ship bao nhiêu?',
  'Có được kiểm tra hàng trước khi thanh toán không?',
  'Cho mình xem thêm ảnh thật sản phẩm với',
  'Đơn hàng của mình đã gửi chưa shop?',
  'Mình muốn đổi size, đổi thế nào ạ?',
  'Shop có chương trình giảm giá cuối tuần không?',
  'Sản phẩm này bảo hành bao lâu?',
  'Địa chỉ cửa hàng ở đâu vậy?',
  'Cảm ơn shop nhiều nhé!',
  'Mình chuyển khoản rồi, shop kiểm tra giúp',
];
const PAGE_LINES = [
  'Chào bạn, shop còn size M nhé. Bạn cho shop xin số điện thoại và địa chỉ để lên đơn ạ.',
  'Dạ sản phẩm này giá 350.000đ, freeship đơn từ 500.000đ bạn nhé.',
  'Phí ship về Đà Nẵng là 25.000đ, 2-3 ngày nhận hàng ạ.',
  'Dạ được ạ, bạn kiểm tra hàng rồi mới thanh toán nhé.',
  'Shop gửi ảnh thật bên dưới nhé, bạn xem giúp shop.',
  'Đơn của bạn đã gửi sáng nay, mã vận đơn shop gửi kèm ạ.',
  'Bạn gửi hàng về shop, shop đổi size miễn phí trong 7 ngày nhé.',
];

const POSTS = [
  'BST Thu Đông 2026 chính thức lên kệ! Giảm 20% cho 100 đơn đầu tiên.',
  'Freeship toàn quốc cuối tuần này. Inbox ngay để được tư vấn size.',
  'Cảm ơn 10.000 khách hàng đã đồng hành cùng shop trong năm qua!',
  'Mini game: Comment màu yêu thích, nhận voucher 50k.',
];
const COMMENT_LINES = [
  'Giá bao nhiêu ạ?',
  'Còn hàng không shop?',
  'Đẹp quá, cho xin giá',
  'Màu xanh ạ!',
  'Ship Hà Nội mất bao lâu?',
  'Màu đỏ nha shop',
  'Mình đặt rồi mà chưa thấy gọi xác nhận',
  'Chất vải thế nào shop?',
];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

export function seedDemo() {
  if (get('SELECT COUNT(*) AS n FROM pages').n > 0) return false;

  const pages = [
    { id: 'demo_page_1', name: 'Shop Thời Trang ABC', category: 'Cửa hàng quần áo', fan_count: 12840, followers_count: 13102, access_token: 'demo' },
    { id: 'demo_page_2', name: 'Quán Cà Phê Sáng', category: 'Quán cà phê', fan_count: 3210, followers_count: 3350, access_token: 'demo' },
  ];
  for (const p of pages) {
    store.upsertPage(p);
    store.setPageMeta(p.id, { subscribed: 1, last_sync: new Date().toISOString() });
  }

  let n = 0;
  for (const p of pages) {
    const count = p.id === 'demo_page_1' ? 9 : 4;
    for (let i = 0; i < count; i++) {
      const psid = `psid_${p.id}_${i + 1}`;
      const name = NAMES[(n++) % NAMES.length];
      store.upsertCustomer(p.id, psid, { name });
      const startH = 2 + Math.random() * 300; // trong 14 ngày
      let t = startH;
      const turns = 1 + Math.floor(Math.random() * 4);
      for (let k = 0; k < turns; k++) {
        t = Math.max(0.3, t);
        store.insertMessage({ pageId: p.id, psid, fromType: 'customer', text: rand(CUSTOMER_LINES), createdTime: hoursAgo(t), source: 'demo', customerName: name });
        t -= 0.2 + Math.random() * 2;
        if (k < turns - 1 || Math.random() > 0.45) {
          store.insertMessage({ pageId: p.id, psid, fromType: 'page', text: rand(PAGE_LINES), createdTime: hoursAgo(Math.max(0.05, t)), source: 'demo' });
          t -= 1 + Math.random() * 6;
        }
      }
    }
    // Vài hội thoại đã đọc / đã xong
    const convs = all('SELECT id FROM conversations WHERE page_id=?', p.id);
    convs.forEach((c, idx) => {
      if (idx % 3 === 0) store.markRead(c.id);
      if (idx % 4 === 3) store.patchConversation(c.id, { status: 'done', tags: ['đã mua'] });
      if (idx % 5 === 1) store.patchConversation(c.id, { tags: ['hỏi giá'], note: 'Khách quan tâm áo khoác dạ, hẹn gọi lại.' });
    });

    POSTS.forEach((msg, pi) => {
      const postId = `${p.id}_post_${pi + 1}`;
      store.upsertPost(p.id, {
        id: postId,
        message: msg,
        created_time: hoursAgo(20 + pi * 50),
        permalink_url: 'https://www.facebook.com/',
        likes: { summary: { total_count: 40 + Math.floor(Math.random() * 400) } },
        comments: { summary: { total_count: 0 } },
        shares: { count: Math.floor(Math.random() * 30) },
      });
      const cCount = 2 + Math.floor(Math.random() * 4);
      for (let ci = 0; ci < cCount; ci++) {
        const cid = `${postId}_c${ci + 1}`;
        store.upsertComment(p.id, {
          id: cid,
          postId,
          from: { id: `asid_${ci}`, name: rand(NAMES) },
          message: rand(COMMENT_LINES),
          created_time: hoursAgo(1 + Math.random() * 60),
        });
        if (ci === 0) {
          store.upsertComment(p.id, {
            id: `${cid}_r`,
            postId,
            parentId: cid,
            from: { id: p.id, name: p.name },
            message: 'Shop đã inbox bạn nhé!',
            created_time: hoursAgo(0.5 + Math.random() * 20),
          });
        }
      }
      run('UPDATE posts SET comments_count=(SELECT COUNT(*) FROM comments WHERE post_id=?) WHERE id=?', postId, postId);
    });
  }

  if (get('SELECT COUNT(*) AS n FROM quick_replies').n === 0) {
    const qrs = [
      ['chao', 'Chào hỏi', 'Chào {name}, cảm ơn bạn đã nhắn tin cho {page}. Shop có thể giúp gì cho bạn ạ?'],
      ['gia', 'Báo giá', 'Dạ sản phẩm bạn hỏi có giá 350.000đ. Freeship cho đơn từ 500.000đ bạn nhé.'],
      ['ship', 'Phí ship', 'Phí ship nội thành 20.000đ, ngoại tỉnh 30.000đ, nhận hàng sau 2-4 ngày ạ.'],
      ['doi', 'Đổi trả', 'Shop hỗ trợ đổi size/đổi mẫu miễn phí trong 7 ngày kể từ khi nhận hàng bạn nhé.'],
      ['camon', 'Cảm ơn', 'Cảm ơn {name} đã ủng hộ shop! Chúc bạn một ngày tốt lành.'],
    ];
    for (const [s, t, b] of qrs) run('INSERT INTO quick_replies(shortcut,title,body) VALUES(?,?,?)', s, t, b);
  }
  if (get('SELECT COUNT(*) AS n FROM auto_rules').n === 0) {
    run(
      `INSERT INTO auto_rules(page_id,enabled,name,match_type,keyword,reply,apply_to,private_reply,priority) VALUES
       (NULL,1,'Hỏi giá','contains','giá, bao nhiêu, price','Chào {name}, shop đã nhận được câu hỏi về giá. Nhân viên sẽ báo giá chi tiết cho bạn trong ít phút nhé!','both',1,10),
       (NULL,1,'Địa chỉ','contains','địa chỉ, ở đâu','Shop ở 123 Lê Lợi, Quận 1, TP.HCM. Mở cửa 9h-21h hằng ngày bạn nhé!','message',0,5),
       (NULL,1,'Mini game','contains','màu','Cảm ơn {name} đã tham gia! Shop sẽ công bố kết quả vào thứ 7 nhé.','comment',0,1)`,
    );
  }
  if (!getSetting('offhours')) {
    setSetting('offhours', {
      enabled: false,
      start: '08:00',
      end: '21:30',
      days: [0, 1, 2, 3, 4, 5, 6],
      reply: 'Cảm ơn bạn đã nhắn tin! Hiện shop ngoài giờ làm việc (8:00-21:30). Shop sẽ phản hồi sớm nhất khi mở cửa ạ.',
    });
  }
  store.logActivity('demo-seed', null, 'Đã tạo dữ liệu demo');
  return true;
}

/** Giả lập một tin nhắn khách gửi tới (kích hoạt cả trả lời tự động). */
export async function simulateIncoming({ pageId, psid, name, text } = {}) {
  const page = store.getPage(pageId) || store.listEnabledPages()[0];
  if (!page) throw new Error('Chưa có trang nào');
  const id = psid || `psid_sim_${Math.floor(Math.random() * 1e6)}`;
  const customerName = name || store.getCustomer(page.id, id)?.name || rand(NAMES);
  const content = text || rand(CUSTOMER_LINES);
  store.upsertCustomer(page.id, id, { name: customerName });
  const r = store.insertMessage({ pageId: page.id, psid: id, fromType: 'customer', text: content, createdTime: Date.now(), source: 'demo', customerName });
  const auto = await handleIncomingMessage(page, id, content, { name: customerName });
  return { message: r.message, conversation_id: r.convId, auto };
}

/** Giả lập một bình luận mới. */
export async function simulateComment({ pageId, postId, name, text } = {}) {
  const page = store.getPage(pageId) || store.listEnabledPages()[0];
  if (!page) throw new Error('Chưa có trang nào');
  const post = (postId && store.getPost(postId)) || store.listPosts(page.id, 1)[0];
  if (!post) throw new Error('Trang chưa có bài viết');
  const cid = `${post.id}_sim_${Math.floor(Math.random() * 1e6)}`;
  const r = store.upsertComment(page.id, {
    id: cid,
    postId: post.id,
    from: { id: `asid_sim_${Math.floor(Math.random() * 1e6)}`, name: name || rand(NAMES) },
    message: text || rand(COMMENT_LINES),
    created_time: Date.now(),
  });
  run('UPDATE posts SET comments_count=comments_count+1 WHERE id=?', post.id);
  const auto = await handleIncomingComment(page, r.comment);
  return { comment: r.comment, auto };
}
