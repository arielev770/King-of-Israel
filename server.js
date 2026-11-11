const express = require('express');
const cors = require('cors');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const MAX_PRICE = 10000;

if (!BOT_TOKEN) {
  console.error('Ошибка: не задана переменная окружения BOT_TOKEN');
  process.exit(1);
}
if (WEBHOOK_URL && !/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET || '')) {
  console.error('Ошибка: при использовании WEBHOOK_URL задайте WEBHOOK_SECRET (A-Z, a-z, 0-9, _ и -)');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function handleUpdate(update) {
  const pcq = update.pre_checkout_query;
  if (pcq) {
    const r = await tg('answerPreCheckoutQuery', {
      pre_checkout_query_id: pcq.id,
      ok: true,
    });
    if (!r.ok) console.error('answerPreCheckoutQuery:', r.description);
  }

  const sp = update.message && update.message.successful_payment;
  if (sp) {
    console.log(
      `Оплачено: ${sp.total_amount} ${sp.currency}, payload=${sp.invoice_payload}, ` +
      `charge_id=${sp.telegram_payment_charge_id}, user=${update.message.from && update.message.from.id}`
    );
  }
}

async function startPolling() {
  const del = await tg('deleteWebhook', { drop_pending_updates: false });
  if (!del.ok) console.error('deleteWebhook:', del.description);
  console.log('Режим: long polling');

  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['pre_checkout_query', 'message'],
      });
      if (!r.ok) {
        console.error('getUpdates:', r.description);
        await sleep(3000);
        continue;
      }
      for (const update of r.result) {
        offset = update.update_id + 1;
        handleUpdate(update).catch((e) => console.error('handleUpdate:', e));
      }
    } catch (e) {
      console.error('polling:', e.message);
      await sleep(3000);
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));

app.get('/', (req, res) => res.json({ ok: true }));

app.post('/create-invoice', async (req, res) => {
  const { title, description, payload, price } = req.body || {};
  const amount = Number(price);

  if (typeof title !== 'string' || !title.trim() || title.length > 32) {
    return res.status(400).json({ ok: false, error: 'title: строка от 1 до 32 символов' });
  }
  const desc = typeof description === 'string' && description.trim() ? description : title;
  if (desc.length > 255) {
    return res.status(400).json({ ok: false, error: 'description: не более 255 символов' });
  }
  if (typeof payload !== 'string' || !payload || Buffer.byteLength(payload) > 128) {
    return res.status(400).json({ ok: false, error: 'payload: строка от 1 до 128 байт' });
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_PRICE) {
    return res.status(400).json({ ok: false, error: `price: целое число от 1 до ${MAX_PRICE}` });
  }

  try {
    const r = await tg('createInvoiceLink', {
      title,
      description: desc,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: title, amount }],
    });
    if (!r.ok) {
      console.error('createInvoiceLink:', r.description);
      return res.status(502).json({ ok: false, error: r.description || 'Ошибка Telegram API' });
    }
    return res.json({ ok: true, invoiceLink: r.result });
  } catch (e) {
    console.error('create-invoice:', e.message);
    return res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/webhook', (req, res) => {
  if (!WEBHOOK_URL || req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  handleUpdate(req.body || {}).catch((e) => console.error('handleUpdate:', e));
});

app.use((err, req, res, next) => {
  res.status(400).json({ ok: false, error: 'Некорректный JSON' });
});

app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  try {
    if (WEBHOOK_URL) {
      const r = await tg('setWebhook', {
        url: `${WEBHOOK_URL.replace(/\/+$/, '')}/webhook`,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ['pre_checkout_query', 'message'],
      });
      if (!r.ok) throw new Error(r.description);
      console.log('Режим: webhook');
    } else {
      startPolling();
    }
  } catch (e) {
    console.error('Не удалось запустить приём обновлений:', e.message);
    process.exit(1);
  }
});
