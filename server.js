// Bot tu dong tra loi fanpage HikariGo — Meta Messenger Platform webhook.
// Chay: npm install && node server.js (doc bien moi truong trong .env.example)

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';

const {
  VERIFY_TOKEN,
  PAGE_ACCESS_TOKEN,
  APP_SECRET = '',
  PORT = 3000,
  LLM_API_URL = '',
  LLM_API_KEY = '',
  LLM_MODEL = '',
  HANDOVER_KEYWORDS = 'nhân viên,người thật,gọi điện,tư vấn viên',
  LEADS_KEY = '',
  LEADS_WEBHOOK_URL = '',
  FOLLOWUP_MINUTES = '10',
} = process.env;

if (!VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.error('Thieu VERIFY_TOKEN hoac PAGE_ACCESS_TOKEN trong bien moi truong.');
  process.exit(1);
}

const knowledge = JSON.parse(
  fs.readFileSync(new URL('./knowledge.json', import.meta.url), 'utf8')
);

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

function verifySignature(req) {
  if (!APP_SECRET) return true; // van khuyen cao cau hinh APP_SECRET khi len production
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Meta goi GET nay de xac minh webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook da duoc xac minh.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta gui tin nhan den qua POST nay
app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(403);
  res.sendStatus(200); // tra loi Meta ngay, xu ly sau
  const body = req.body;
  if (body.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const msg = event.message;
      if (msg && !msg.is_echo && msg.text && !alreadyProcessed(msg.mid)) {
        handleMessage(event.sender.id, msg.text).catch((e) =>
          console.error('Loi xu ly tin nhan:', e.message)
        );
      }
    }
  }
});

// ---- Thu thap so dien thoai khach (lead) de nhan vien tu van lai ----

const nameCache = new Map(); // senderId -> ten
const askedPhone = new Set(); // senderId da duoc hoi so
const gavePhone = new Set(); // senderId da cho so
const LEADS_FILE = new URL('./leads.json', import.meta.url);

// Chong tra loi trung neu Meta gui lai cung event (luu mid 30 phut)
const seenMids = new Map();
function alreadyProcessed(mid) {
  if (!mid) return false;
  const now = Date.now();
  if (seenMids.has(mid)) return true;
  seenMids.set(mid, now);
  if (seenMids.size > 1000) {
    for (const [k, t] of seenMids) if (now - t > 30 * 60 * 1000) seenMids.delete(k);
  }
  return false;
}

// Lay ten khach tu Meta (best-effort, co cache)
async function getCustomerName(senderId) {
  if (nameCache.has(senderId)) return nameCache.get(senderId);
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${senderId}?fields=first_name,last_name&access_token=${PAGE_ACCESS_TOKEN}`
    );
    const data = await r.json();
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
    if (name) nameCache.set(senderId, name);
    return name || '';
  } catch {
    return '';
  }
}

// Nhan dien so dien thoai Viet Nam: 0xxxxxxxxx hoac +84xxxxxxxxx
function extractPhone(text) {
  const m = text.replace(/[\s.]/g, '').match(/(^|\D)(0\d{9}|\+84\d{9})(\D|$)/);
  if (!m) return '';
  let phone = m[2];
  if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
  return phone;
}

function saveLead(senderId, name, phone, lastMessage) {
  const lead = {
    senderId,
    name: name || '',
    phone,
    lastMessage: lastMessage.slice(0, 200),
    time: new Date().toISOString(),
  };
  try {
    let leads = [];
    if (fs.existsSync(LEADS_FILE)) {
      leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    }
    // Cap nhat neu khach da co trong danh sach
    const idx = leads.findIndex((l) => l.senderId === senderId);
    if (idx >= 0) leads[idx] = lead;
    else leads.push(lead);
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  } catch (e) {
    console.error('Loi luu lead:', e.message);
  }
  // Log ro rang de xem trong Render Logs
  console.log(`[LEAD MOI] ${name || '?'} - ${phone} - noi: "${lastMessage.slice(0, 80)}"`);
  // Day lead sang Google Sheet de khong phu thuoc o dia tam cua Render
  if (LEADS_WEBHOOK_URL) {
    fetch(LEADS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
    }).catch((e) => console.error('Gui lead di backup that bai:', e.message));
  }
}

// Ca nhan hoa cau tra loi: chi goi ten o loi chao va dau cau,
// giu nguyen "anh/chị" o giua cau de dung ngu phap
function personalize(text, name) {
  if (!name) return text;
  return text
    .replace('Chào anh/chị', `Chào ${name}`)
    .replace(/^Anh\/chị/, name);
}

function phoneRequest(name) {
  const who = name ? name : 'Anh/chị';
  return `${who} vui lòng cho em xin số điện thoại để các bạn nhân viên bên em tư vấn hỗ trợ kỹ hơn ạ.`;
}

// Tin nhan tu dong sau X phut khach khong tra loi
function followupPhoneRequest(name) {
  const greet = name
    ? `Dạ em chưa thấy ${name} phản hồi ạ.`
    : 'Dạ em chưa thấy anh/chị phản hồi ạ.';
  return `${greet} ${name || 'Anh/chị'} vui lòng cho em xin số điện thoại để các bạn nhân viên bên em tư vấn hỗ trợ kỹ hơn ạ.`;
}

const FOLLOWUP_DELAY_MS = Math.max(1, parseInt(FOLLOWUP_MINUTES, 10) || 10) * 60 * 1000;
const followupTimers = new Map(); // senderId -> timeout
const lastActivity = new Map(); // senderId -> timestamp tin nhan cuoi cua khach

function schedulePhoneFollowup(senderId, name) {
  if (askedPhone.has(senderId) || gavePhone.has(senderId)) return;
  if (followupTimers.has(senderId)) clearTimeout(followupTimers.get(senderId));
  const timer = setTimeout(async () => {
    followupTimers.delete(senderId);
    const last = lastActivity.get(senderId) || 0;
    if (Date.now() - last < FOLLOWUP_DELAY_MS) return; // khach vua nhan tin lai
    if (askedPhone.has(senderId) || gavePhone.has(senderId)) return;
    askedPhone.add(senderId);
    try {
      await sendMessage(senderId, followupPhoneRequest(name));
      console.log(`Da gui tin xin so (follow-up) cho ${senderId}`);
    } catch (e) {
      console.error('Loi gui follow-up:', e.message);
    }
  }, FOLLOWUP_DELAY_MS);
  if (timer.unref) timer.unref();
  followupTimers.set(senderId, timer);
}

const menuState = new Map(); // senderId -> index danh muc dang xem

function categoryMenuText() {
  let t = 'Dạ, anh/chị chọn mục cần hỏi ạ:';
  knowledge.menu.forEach((c, i) => { t += `\n${i + 1}. ${c.title}`; });
  t += '\n\nAnh/chị nhắn số mục (ví dụ: 1) ạ.';
  return t;
}

function questionMenuText(catIdx) {
  const c = knowledge.menu[catIdx];
  let t = `Dạ, mục "${c.title}" có các câu hỏi sau ạ:`;
  c.questions.forEach((q, i) => { t += `\n${i + 1}. ${q.label}`; });
  t += '\n\nAnh/chị nhắn số câu hỏi để xem trả lời, hoặc nhắn "menu" để về danh mục chính ạ.';
  return t;
}

// Tra ve {handled, reply, keepMenu}. keepMenu=true: giu nguyen danh muc dang xem
function handleMenuInput(senderId, text) {
  const t = text.trim().toLowerCase();
  if (['menu', 'danh mục', 'danh muc', 'mục lục', 'muc luc'].includes(t)) {
    menuState.delete(senderId);
    return { handled: true, reply: categoryMenuText() };
  }
  if (!/^\d{1,2}$/.test(t)) return { handled: false };
  const n = parseInt(t, 10);
  const cat = menuState.get(senderId);
  if (cat === undefined) {
    if (n >= 1 && n <= knowledge.menu.length) {
      menuState.set(senderId, n - 1);
      return { handled: true, reply: questionMenuText(n - 1) };
    }
    return { handled: false };
  }
  const questions = knowledge.menu[cat].questions;
  if (n >= 1 && n <= questions.length) {
    return { handled: true, keepMenu: true, reply: knowledge.faqs[questions[n - 1].faq].answer };
  }
  return {
    handled: true,
    keepMenu: true,
    reply: `Dạ, mục này có ${questions.length} câu hỏi, anh/chị chọn số từ 1 đến ${questions.length} giúp em ạ.`,
  };
}

async function handleMessage(senderId, text) {
  console.log(`Nhan tu ${senderId}: ${text}`);
  const name = await getCustomerName(senderId);
  lastActivity.set(senderId, Date.now());

  // Khach cho so dien thoai -> luu lead, xac nhan
  const phone = extractPhone(text);
  if (phone && !gavePhone.has(senderId)) {
    gavePhone.add(senderId);
    saveLead(senderId, name, phone, text);
    const who = name ? ` ${name}` : ' anh/chị';
    await sendMessage(
      senderId,
      `Dạ em đã ghi nhận số ${phone} của${who} ạ. Nhân viên bên em sẽ liên hệ tư vấn sớm nhất ạ.`
    );
    return;
  }

  // Menu danh muc cau hoi
  if (knowledge.menu) {
    const menuRes = handleMenuInput(senderId, text);
    if (menuRes.handled) {
      await sendMessage(senderId, personalize(menuRes.reply, name));
      schedulePhoneFollowup(senderId, name);
      return;
    }
  }

  const { reply, needsPhone, faqIndex } = await craftReply(text);

  // Khi bot khong tra loi duoc / chuyen nhan vien -> xin so de tu van lai (chi hoi 1 lan)
  let finalReply = personalize(reply, name);
  if (needsPhone && !askedPhone.has(senderId) && !gavePhone.has(senderId)) {
    askedPhone.add(senderId);
    finalReply += `\n\n${phoneRequest(name)}`;
  }
  await sendMessage(senderId, finalReply);

  // Hen gio: neu khach im lang X phut thi tu dong nhan xin so
  schedulePhoneFollowup(senderId, name);
}

async function craftReply(text) {
  const lower = text.toLowerCase();

  // Khach muon gap nguoi that -> bao chuyen cho nhan vien + xin so
  if (HANDOVER_KEYWORDS.split(',').some((k) => lower.includes(k.trim()))) {
    return { reply: knowledge.handover_message, needsPhone: true, faqIndex: -1 };
  }

  // Uu tien 1: tra loi theo FAQ co san (chinh xac, khong ton chi phi AI)
  for (let i = 0; i < knowledge.faqs.length; i++) {
    const item = knowledge.faqs[i];
    if (item.keywords.some((k) => lower.includes(k.toLowerCase()))) {
      let reply = item.answer;
      // Cau chao: goi y them menu danh muc
      if (i === 0 && knowledge.menu) {
        reply += '\n\nAnh/chị nhắn "menu" để xem danh mục các câu hỏi thường gặp ạ.';
      }
      return { reply, needsPhone: false, faqIndex: i };
    }
  }

  // Uu tien 2: AI tra loi tu do (can cau hinh LLM_API_URL + LLM_API_KEY)
  if (LLM_API_URL && LLM_API_KEY) {
    try {
      return { reply: await llmReply(text), needsPhone: false, faqIndex: -1 };
    } catch (e) {
      console.error('LLM loi:', e.message);
    }
  }

  // Khong tra loi duoc -> xin so de nhan vien tu van
  return { reply: knowledge.fallback, needsPhone: true, faqIndex: -1 };
}

// Ghep FAQ thanh boi canh de AI suy luan cau tra loi cho cau hoi moi
function buildLlmSystemPrompt() {
  const faqText = knowledge.faqs
    .map((f) => `- Khi khach hoi ve: ${f.keywords.join(', ')}\n  Tra loi mau: ${f.answer}`)
    .join('\n');
  return (
    `${knowledge.system_prompt}\n\n` +
    `Thong tin chinh thuc cua HikariGo, hay dung de suy luan tra loi cac cau hoi moi:\n${faqText}\n\n` +
    `Neu cau hoi nam ngoai thong tin tren, hay suy luan cau tra loi hop ly nhat tu nhung gi da biet, ` +
    `giu giong van than thien cua page. Neu that su khong chac chan, ket thuc bang cau: ` +
    `'De chac chan, em se chuyen cho nhan vien xac nhan lai a.'`
  );
}

async function llmReply(userText) {
  // Ho tro 2 chuan: Anthropic Messages API va OpenAI-compatible
  if (LLM_API_URL.includes('anthropic.com')) {
    const r = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': LLM_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 500,
        system: buildLlmSystemPrompt(),
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!r.ok) throw new Error(`Claude HTTP ${r.status}`);
    const data = await r.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) throw new Error('Claude tra ve rong');
    return text.slice(0, 1900);
  }

  const r = await fetch(LLM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: buildLlmSystemPrompt() },
        { role: 'user', content: userText },
      ],
      max_tokens: 500,
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM tra ve rong');
  return text.slice(0, 1900);
}

async function sendMessage(senderId, text) {
  const r = await fetch(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: senderId },
        messaging_type: 'RESPONSE',
        message: { text: text.slice(0, 2000) },
      }),
    }
  );
  if (!r.ok) console.error('Gui tin nhan that bai:', await r.text());
  else console.log(`Da tra loi ${senderId}`);
}

app.get('/health', (_req, res) => res.send('ok'));

// Xem danh sach lead — yeu cau ?key= neu da dat LEADS_KEY
app.get('/leads', (req, res) => {
  if (LEADS_KEY && req.query.key !== LEADS_KEY) return res.sendStatus(403);
  try {
    if (!fs.existsSync(LEADS_FILE)) return res.json([]);
    return res.json(JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')));
  } catch {
    return res.status(500).json({ error: 'khong doc duoc leads' });
  }
});

app.listen(PORT, () => console.log(`Bot dang chay o cong ${PORT}`));
