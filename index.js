const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const express = require('express');
const QRCode = require('qrcode');

// Initialize Groq SDK (Reads GROQ_API_KEY from Render environment variables)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Express Server Setup to show QR Code in browser
const app = express();
const PORT = process.env.PORT || 3000;
let currentQrCode = null;

app.get('/', async (req, res) => {
  if (!currentQrCode) {
    return res.send('<h2>WhatsApp Bot is connected or generating QR code... Refresh in a few seconds.</h2>');
  }
  try {
    const qrImage = await QRCode.toDataURL(currentQrCode);
    res.send(`
      <html>
        <head><title>Scan WhatsApp QR Code</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h1>Scan to Link WhatsApp</h1>
          <img src="${qrImage}" style="width:300px;height:300px;"/>
          <p>Open WhatsApp on your phone > Linked Devices > Link a Device.</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error rendering QR code');
  }
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

// WhatsApp Bot Core Logic
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      currentQrCode = qr;
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp Bot successfully connected!');
      currentQrCode = null; // Clear QR code once connected
    }
  });

  // Listen for incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignore messages sent by the bot itself or broadcast/status messages
      if (msg.key.fromMe || !msg.message) continue;

      const senderJid = msg.key.remoteJid;
      
      // Filter for private chat messages only
      if (!senderJid.endsWith('@s.whatsapp.net')) continue;

      // Extract text from standard message, extended text, or conversation
      const userMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!userMessage) continue;

      try {
        // Send typing indicator
        await sock.sendPresenceUpdate('composing', senderJid);

        // Fetch AI Response from Groq
        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: 'user', content: userMessage }],
          model: 'openai/gpt-oss-120b',
        });

        const replyText = chatCompletion.choices[0]?.message?.content || "Sorry, I couldn't process that.";

        // Reply immediately back to the user
        await sock.sendMessage(senderJid, { text: replyText }, { quoted: msg });
      } catch (error) {
        console.error('Error generating AI response:', error);
      }
    }
  });
}

connectToWhatsApp();
