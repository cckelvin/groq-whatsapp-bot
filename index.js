const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const express = require('express');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
const PORT = process.env.PORT || 10000;
let sock = null;
let currentCode = null;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Link WhatsApp</title></head>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <h1>WhatsApp Pairing Service</h1>
        ${
          currentCode
            ? `<div style="font-size: 36px; font-weight: bold; background: #f0f0f0; padding: 15px 25px; border-radius: 8px;">${currentCode}</div>`
            : `<a href="/pair" style="font-size:20px;padding:12px 24px;background:#075e54;color:white;text-decoration:none;border-radius:6px;">Get New Pairing Code</a>`
        }
        <p style="margin-top:20px;">Open WhatsApp > Linked Devices > Link a Device > Link with phone number instead.</p>
      </body>
    </html>
  `);
});

app.get('/pair', async (req, res) => {
  if (!sock) {
    return res.send('WhatsApp socket not initialized yet. Wait a few seconds and refresh.');
  }
  try {
    // Wait 3 seconds to ensure connection stability before requesting
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const code = await sock.requestPairingCode('2349159759552');
    currentCode = code;
    res.redirect('/');
  } catch (err) {
    console.error('Failed to request pairing code:', err);
    res.send('Error generating code. Please go back and try again in 10 seconds.');
  }
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      currentCode = null;
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp Bot connected successfully!');
      currentCode = null;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const senderJid = msg.key.remoteJid;
      if (!senderJid.endsWith('@s.whatsapp.net')) continue;

      const userMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!userMessage) continue;

      try {
        await sock.sendPresenceUpdate('composing', senderJid);

        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: 'user', content: userMessage }],
          model: 'openai/gpt-oss-120b',
        });

        const replyText = chatCompletion.choices[0]?.message?.content || "Sorry, I couldn't process that.";
        await sock.sendMessage(senderJid, { text: replyText }, { quoted: msg });
      } catch (error) {
        console.error('Error handling message:', error);
      }
    }
  });
}

connectToWhatsApp();
