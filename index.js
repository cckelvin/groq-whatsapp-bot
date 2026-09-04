const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const express = require('express');
const fs = require('fs');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
const PORT = process.env.PORT || 10000;
let sock = null;
let currentCode = null;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Link WhatsApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;padding:20px;">
        <h1>WhatsApp Pairing Service</h1>
        ${
          currentCode
            ? `<div style="font-size: 32px; font-weight: bold; background: #e0f2fe; color: #0369a1; padding: 15px 25px; border-radius: 8px; letter-spacing: 4px; user-select: all;">${currentCode}</div>
               <p style="color:#d97706;font-weight:bold;">Enter this code into WhatsApp quickly before it expires!</p>`
            : `<a href="/pair" style="font-size:20px;padding:14px 28px;background:#075e54;color:white;text-decoration:none;border-radius:8px;font-weight:bold;">Generate Pairing Code</a>`
        }
        <p style="margin-top:25px;color:#555;">Open WhatsApp > Linked Devices > Link a Device > Link with phone number instead.</p>
      </body>
    </html>
  `);
});

app.get('/pair', async (req, res) => {
  if (!sock) {
    return res.send('WhatsApp bot initializing... Please go back and refresh in 5 seconds.');
  }
  try {
    // Generate fresh code for Nigeria number (+234)
    const code = await sock.requestPairingCode('2349159759552');
    currentCode = code;
    res.redirect('/');
  } catch (err) {
    console.error('Pairing error:', err);
    res.send('Error generating code. Please go back, wait 5 seconds, and try again.');
  }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed. Status code:', statusCode);
      currentCode = null;

      // If pairing failed or logged out, wipe saved session folder to start clean
      if (statusCode === DisconnectReason.loggedOut || statusCode === 400) {
        console.log('Clearing corrupt auth state...');
        if (fs.existsSync('auth_info_baileys')) {
          fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        }
      }
      
      setTimeout(connectToWhatsApp, 5000);
    } else if (connection === 'open') {
      console.log('WhatsApp Bot successfully connected!');
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
        console.error('Error answering message:', error);
      }
    }
  });
}

connectToWhatsApp();
  
