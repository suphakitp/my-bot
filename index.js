require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

/* ================= MEMORY ================= */
const groupState = {};

app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook error:", err);
    res.sendStatus(500);
  }
});

/* ================= ฟังก์ชันดึงชื่อโลเคชั่น ================= */
function extractLocation(text) {
  text = text.trim();
  let match = text.match(/(?:Location|แปลง)\s*(.*?)\s*(?::|$)/i);
  if (match && match[1]) return match[1].trim();
  if (/^[a-z]$/i.test(text)) return text.toUpperCase();
  // กรณีพิมพ์ชื่อไทยเฉยๆ หรือชื่อเฉพาะ
  if (text.length > 0 && text.length < 20 && !['บันทึก', 'บันทึกรูปภาพ'].includes(text)) return text;
  return null;
}

/* ================= ฟังก์ชันบันทึกรูปภาพ ================= */
async function processSaveImages(groupId, state, isAuto = false) {
  if (state.buffer.length === 0) return;

  const total = state.buffer.length;
  const pushTarget = groupId;
  const modeText = isAuto ? "⏰ ระบบบันทึกอัตโนมัติ" : "⏳ กำลังบันทึกรูปภาพ";
  
  await client.pushMessage(pushTarget, { 
    type: 'text', 
    text: `${modeText} ทั้งหมด ${total} รูป... กรุณารอสักครู่` 
  });

  let count = 0;
  const summary = {};

  for (let i = 0; i < state.buffer.length; i++) {
    const item = state.buffer[i];
    // ถ้าไม่มีชื่อโลเคชั่น ให้ใช้ UNKNOWN
    const targetLoc = item.location || "UNKNOWN";
    const dateStr = new Date(item.timestamp + (7 * 60 * 60 )).toISOString().split('T')[0];

    try {
      await saveImage(item.id, targetLoc, dateStr, item.timestamp);
      count++;
      const key = `${targetLoc}/${dateStr}`;
      summary[key] = (summary[key] || 0) + 1;
    } catch (err) {
      console.error(`❌ Save error:`, err.message);
    }
  }

  // ล้างค่าเมื่อบันทึกเสร็จ
  state.buffer = [];
  state.lastLocation = null;

  let summaryText = `✅ ${isAuto ? 'บันทึกอัตโนมัติ' : 'บันทึก'} เสร็จสิ้น! (${count}/${total} รูป)\n`;
  summaryText += `📅 ระบบเริ่มนับรอบใหม่\n\n`;

  const sortedKeys = Object.keys(summary).sort(); 
  for (const key of sortedKeys) {
    summaryText += `📁 ${key} → ${summary[key]} รูป\n`;
  }
  
  await client.pushMessage(pushTarget, { type: 'text', text: summaryText });
}

/* ================= MAIN LOGIC ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;
  if (!groupState[groupId]) {
    groupState[groupId] = { buffer: [], lastLocation: null };
  }
  const state = groupState[groupId];

  // 1. รับรูปภาพ (เก็บไว้เฉยๆ ยังไม่ใส่ชื่อ)
  if (event.message.type === 'image') {
    state.buffer.push({ 
      id: event.message.id, 
      timestamp: event.timestamp, 
      location: null // บังคับเป็น null เพื่อรอชื่อตามหลัง
    });
    return;
  }

  // 2. รับข้อความ
  if (event.message.type === 'text') {
    const text = event.message.text.trim();

    if (text === 'บันทึก' || text === 'บันทึกรูปภาพ') {
      if (state.buffer.length === 0) return reply(event.replyToken, "⚠️ ไม่มีรูปค้างในระบบ");
      await reply(event.replyToken, "👌 รับทราบครับ กำลังเริ่มบันทึก...");
      await processSaveImages(groupId, state, false);
      return;
    }

    // ตรวจสอบว่าเป็นชื่อโลเคชั่นหรือไม่
    const loc = extractLocation(text);
    if (loc) {
      let updated = 0;
      // วิ่งไปเติมชื่อให้รูปที่ยังว่างอยู่ (รูปที่เพิ่งส่งมาก่อนหน้าข้อความนี้)
      for (let item of state.buffer) {
        if (!item.location) {
          item.location = loc;
          updated++;
        }
      }
      // ถ้าไม่มีรูปว่างเลย (อาจจะพิมพ์ชื่อก่อนส่งรูป) ให้จำค่านี้ไว้เผื่อรูปที่จะตามมา
      if (updated === 0) {
        state.lastLocation = loc;
      } else {
        // ถ้าเติมชื่อให้รูปเก่าไปแล้ว ให้ล้างค่าจำทิ้ง จะได้ไม่ไปทับรูปชุดถัดไป
        state.lastLocation = null;
      }
      return;
    }
  }
}

/* ================= SAVE TO CLOUDINARY ================= */
async function saveImage(messageId, location, dateStr, timestamp) {
  const thaiTime = new Date(timestamp + (7 * 60 * 60 * 1000));

  const datePart = thaiTime.toISOString().split('T')[0];

  const hours = String(thaiTime.getHours()).padStart(2, '0');
const minutes = String(thaiTime.getMinutes()).padStart(2, '0');

const timePart = `${hours}-${minutes}`;


const cleanLocation = (location || "UNKNOWN")
  .replace(/^Location\s*/i, "")   // ลบเฉพาะคำว่า Location
  .replace(/\s+/g, " ")           // จัดช่องว่าง
  .trim();

const finalFileName = `Loc ${cleanLocation} ${datePart}_Time ${timePart}`;

  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) { chunks.push(chunk); }
  const buffer = Buffer.concat(chunks);

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { 
        folder: `${location}/${dateStr}`, 
        public_id: finalFileName, 
        overwrite: true, 
        resource_type: "image" 
      },
      (err, result) => { if (err) return reject(err); resolve(result); }
    ).end(buffer);
  });
}

function reply(token, text) { return client.replyMessage(token, { type: 'text', text }); }

app.listen(process.env.PORT || 3000, () => console.log('🚀 Ready: Photo-First Mode'));