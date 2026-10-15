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
      if (msg && !msg.is_echo && msg.text) {
        handleMessage(event.sender.id, msg.text).catch((e) =>
          console.error('Loi xu ly tin nhan:', e.message)
        );
      }
    }
  }
});

async function handleMessage(senderId, text) {
  console.log(`Nhan tu ${senderId}: ${text}`);
  const reply = await craftReply(text);
  await sendMessage(senderId, reply);
}

async function craftReply(text) {
  const lower = text.toLowerCase();

  // Khach muon gap nguoi that -> bao chuyen cho nhan vien
  if (HANDOVER_KEYWORDS.split(',').some((k) => lower.includes(k.trim()))) {
    return knowledge.handover_message;
  }

  // Uu tien 1: tra loi theo FAQ co san (chinh xac, khong ton chi phi AI)
  for (const item of knowledge.faqs) {
    if (item.keywords.some((k) => lower.includes(k.toLowerCase()))) {
      return item.answer;
    }
  }

  // Uu tien 2: AI tra loi tu do (can cau hinh LLM_API_URL + LLM_API_KEY)
  if (LLM_API_URL && LLM_API_KEY) {
    try {
      return await llmReply(text);
    } catch (e) {
      console.error('LLM loi:', e.message);
    }
  }

  return knowledge.fallback;
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

app.listen(PORT, () => console.log(`Bot dang chay o cong ${PORT}`));
