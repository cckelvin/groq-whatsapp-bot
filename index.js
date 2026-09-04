const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const express = require('express');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;
let pairingCode = null;

app.get('/', (req, res) => {
  if (!pairingCode) {
    return res.send(`
      <html>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">
          <h2>Bot is connected or generating code... Refresh in a few seconds.</h2>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <head><title>Link WhatsApp</title></head>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <h1>Your Pairing Code</h1>
        <div style="font-size: 40px; font-weight: bold; letter-spacing: 5px; background: #eee; padding: 15px 25px; border-radius: 8px;">
          ${pairingCode}
        </div>
        <ol style="margin-top: 20px; text-align: left;">
          <li>Open WhatsApp on this tablet.</li>
          <li>Tap <b>Settings</b> (or 3 dots) > <b>Linked Devices</b>.</li>
          <li>Tap <b>Link a Device</b>.</li>
          <li>Tap <b>Link with phone number instead</b> at the bottom.</li>
          <li>Type the code shown above.</li>
        </ol>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Trigger pairing code if not registered
    if (qr && !sock.authState.creds.registered) {
      try {
        // Formatted with country code for Nigeria (234) without '+'
        const code = await sock.requestPairingCode('2349159759552');
        pairingCode = code;
        console.log('Pairing Code:', code);
      } catch (err) {
        console.error('Error requesting pairing code:', err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp Bot connected successfully!');
      pairingCode = null;
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
        console.error('Error processing message:', error);
      }
    }
  });
}

connectToWhatsApp();
          
