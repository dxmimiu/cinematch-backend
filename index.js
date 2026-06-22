const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); 
const db = require('./database'); 

const app = express();
const PORT = 5000;
// คีย์ลับสำหรับใช้ในการเข้ารหัสและถอดรหัส JWT Token
const SECRET_KEY = 'cinematch_super_secret_key'; 

// เปิดใช้งาน CORS เพื่อให้แอปพลิเคชันหน้าบ้าน (Frontend) สามารถดึงข้อมูลข้ามโดเมนได้
app.use(cors());
// ตั้งค่าระบบให้รองรับและแปลงข้อมูลที่ส่งมาในรูปแบบ JSON Object
app.use(express.json()); 

// ฟังก์ชันตรวจสอบความถูกต้องของ JWT Token (Middleware)
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  // หากไม่มีการแนบ Header Authorization มาด้วย จะทำการปฏิเสธการเข้าถึง
  if (!authHeader) return res.status(403).json({ message: 'ไม่มี Token อนุญาตให้เข้าถึง' });

  // แยกเอาเฉพาะตัว Token ออกมาจากคำว่า Bearer
  const token = authHeader.split(' ')[1]; 
  // ตรวจสอบความถูกต้องของ Token ด้วยคีย์ลับ
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    // หาก Token ไม่ถูกต้องหรือหมดอายุ จะส่งสถานะ 401 กลับไป
    if (err) return res.status(401).json({ message: 'Token ไม่ถูกต้องหรือหมดอายุแล้ว' });
    // บันทึกข้อมูลที่ถอดรหัสได้ลงใน req.user เพื่อให้ระบบส่วนอื่นนำไปใช้งานต่อ
    req.user = decoded;
    next();
  });
};

// --- ระบบยืนยันตัวตนและบัญชีผู้ใช้ (Auth Routes) ---

// พาทสำหรับการลงทะเบียนผู้ใช้ใหม่
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });

  try {
    // สร้าง Salt และทำการเข้ารหัสรหัสผ่านด้วยระบบ bcrypt ก่อนบันทึก
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    // บันทึกข้อมูลผู้ใช้ลงฐานข้อมูล SQLite
    db.run(`INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`, [name, email, passwordHash], function(err) {
      if (err) return res.status(400).json({ message: 'อีเมลนี้มีในระบบแล้ว' });
      res.status(201).json({ message: 'สมัครสมาชิกเรียบร้อย' });
    });
  } catch (error) {
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

// พาทสำหรับเข้าสู่ระบบ
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  // ค้นหาผู้ใช้จากอีเมลที่ระบุ
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    // ตรวจสอบความถูกต้องของรหัสผ่านที่ส่งมาเปรียบเทียบกับตัวที่เข้ารหัสในฐานข้อมูล
    if (!user || !(await bcrypt.compare(password, user.password_hash))) 
      return res.status(400).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    
    // สร้าง JWT Token โดยกำหนดให้มีอายุการใช้งาน 1 วัน
    const token = jwt.sign({ id: user.id, name: user.name, has_completed_quiz: user.has_completed_quiz }, SECRET_KEY, { expiresIn: '1d' });
    // ส่ง Token และข้อมูลผู้ใช้ที่จำเป็นกลับไปให้หน้าบ้าน
    res.json({ token, user: { id: user.id, name: user.name, has_completed_quiz: user.has_completed_quiz } });
  });
});

// พาทสำหรับตรวจสอบสถานะผู้ใช้งานปัจจุบันผ่าน Token
app.get('/api/verify', verifyToken, (req, res) => {
  db.get(`SELECT id, name, has_completed_quiz FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    res.json({ valid: true, user });
  });
});

// --- ระบบบันทึกและคำนวณความพึงพอใจ (Preference & Quiz Routes) ---

// อัปเดตสถานะการทำแบบทดสอบแรกเริ่มของผู้ใช้ว่าเสร็จสิ้นแล้ว
app.post('/api/users/complete-quiz', verifyToken, (req, res) => {
  db.run(`UPDATE users SET has_completed_quiz = 1 WHERE id = ?`, [req.user.id], () => res.json({ message: 'Success' }));
});

// บันทึกหรือคำนวณคะแนนความพึงพอใจตามประเภทหนัง (Genre Preferences)
app.post('/api/update-preference', verifyToken, (req, res) => {
  const { key, score } = req.body;
  // ใช้คำสั่ง ON CONFLICT เพื่อทำการสร้างข้อมูลใหม่ หากยังไม่มี หรือทำการอัปเดตบวกคะแนนเพิ่มหากมีข้อมูลเดิมอยู่แล้ว
  db.run(`INSERT INTO user_preferences (user_id, pref_key, pref_value) VALUES (?, ?, ?) 
          ON CONFLICT(user_id, pref_key) DO UPDATE SET pref_value = pref_value + ?`, 
          [req.user.id, key, score, score]);
  res.json({ message: 'Updated' });
});

// --- ระบบจัดการรายการที่ชอบและไม่ชอบ (Likes Management) ---

// พาทสำหรับบันทึกภาพยนตร์ที่ผู้ใช้กดถูกใจ (Like) หรือไม่ถูกใจ (Dislike)
app.post('/api/likes', verifyToken, (req, res) => {
  const { film_id, film_title, type } = req.body;
  // ตรวจสอบว่าเคยมีการบันทึกภาพยนตร์เรื่องนี้ไปแล้วหรือไม่
  db.get(`SELECT id FROM user_likes WHERE user_id = ? AND film_id = ?`, [user_id = req.user.id, film_id], (err, row) => {
    // ถ้ามีข้อมูลอยู่แล้วให้เปลี่ยนสถานะประเภทการกด (เช่น สลับจากชอบเป็นไม่ชอบ)
    if (row) db.run(`UPDATE user_likes SET type = ? WHERE id = ?`, [type, row.id]);
    // ถ้ายังไม่มีข้อมูลให้ทำการบันทึกข้อมูลใหม่ลงตารางฐานข้อมูล
    else db.run(`INSERT INTO user_likes (user_id, film_id, film_title, type) VALUES (?, ?, ?, ?)`, [req.user.id, film_id, film_title, type]);
    res.json({ message: 'Saved' });
  });
});

// พาทสำหรับดึงรายการภาพยนตร์ที่ชอบและไม่ชอบทั้งหมดของผู้ใช้ออกมาแสดงผล
app.get('/api/likes', verifyToken, (req, res) => {
  db.all(`SELECT film_id, film_title, type FROM user_likes WHERE user_id = ?`, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ message: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    
    // คัดกรองข้อมูลออกเป็นสองกลุ่มตามประเภทเพื่อส่งกลับไปให้หน้าบ้านแสดงผลในแต่ละแท็บ
    const liked = rows ? rows.filter(row => row.type === 'like') : [];
    const disliked = rows ? rows.filter(row => row.type === 'dislike') : [];
    
    res.json({ liked, disliked });
  });
});

// พาทสำหรับลบภาพยนตร์ออกจากคอลเลกชัน
app.delete('/api/likes/:film_id', verifyToken, (req, res) => {
  db.run(`DELETE FROM user_likes WHERE user_id = ? AND film_id = ?`, [req.user.id, req.params.film_id], function(err) {
    if (err) return res.status(500).json({ message: 'เกิดข้อผิดพลาดในการลบข้อมูล' });
    res.json({ message: 'ยกเลิกรายการเรียบร้อยแล้ว' });
  });
});

// --- ระบบจัดการห้องสำหรับจับคู่ภาพยนตร์กลุ่ม (Room Routes) ---

// สร้างห้องใหม่และกำหนดรหัสผ่านสุ่ม 4 หลัก (PIN)
app.post('/api/create-room', verifyToken, (req, res) => {
  const pin = Math.floor(1000 + Math.random() * 9000).toString();
  db.run(`INSERT INTO rooms (pin, host_id, status) VALUES (?, ?, 'waiting')`, [pin, req.user.id], (err) => {
    if (err) return res.status(500).json({ message: 'สร้างห้องไม่สำเร็จ' });
    res.json({ pin });
  });
});

// ดึงสถานะปัจจุบันของห้องและชื่อผู้สร้างห้องผ่านรหัส PIN
app.get('/api/room-status/:pin', verifyToken, (req, res) => {
  db.get(`SELECT r.status, u.name as host FROM rooms r JOIN users u ON r.host_id = u.id WHERE r.pin = ?`, [req.params.pin], (err, row) => {
    if (!row) return res.status(404).json({ message: 'ไม่พบห้อง' });
    res.json(row);
  });
});

// อัปเดตสถานะห้องเมื่อผู้สร้างห้องกดเริ่มกระบวนการสุ่มจับคู่ภาพยนตร์
app.post('/api/start-room', verifyToken, (req, res) => {
  db.run(`UPDATE rooms SET status = 'started' WHERE pin = ?`, [req.body.pin], () => res.json({ message: 'Started' }));
});

// ลบห้องออกจากระบบเมื่อผู้สร้างห้องหรือสมาชิกออกจากห้อง
app.delete('/api/leave-room/:pin', verifyToken, (req, res) => {
  db.run(`DELETE FROM rooms WHERE pin = ?`, [req.params.pin], () => res.json({ message: 'Left' }));
});

// เปิดการทำงานเซิร์ฟเวอร์หลังบ้านตามพอร์ตที่กำหนด
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});