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
    
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL
    // 🟢 เปลี่ยนเครื่องหมาย ? เป็น $1, $2, $3
    await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)`, 
      [name, email, passwordHash]
    );
    
    res.status(201).json({ message: 'สมัครสมาชิกเรียบร้อย' });
    
  } catch (error) {
    // ใน PostgreSQL ถ้าเกิด Error ซ้ำ (เช่น อีเมลซ้ำตามเงื่อนไข UNIQUE) 
    // จะโยนเข้ามาใน catch block นี้ครับ
    console.error('Register Error:', error);
    res.status(400).json({ message: 'อีเมลนี้มีในระบบแล้ว หรือเกิดข้อผิดพลาด' });
  }
});

// พาทสำหรับเข้าสู่ระบบ
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    // 🟢 เปลี่ยนมาใช้ pool.query และเปลี่ยนเครื่องหมาย ? เป็น $1
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    const user = result.rows[0]; // ดึงข้อมูลผู้ใช้แถวแรก

    // ตรวจสอบความถูกต้องของรหัสผ่านที่ส่งมาเปรียบเทียบกับตัวที่เข้ารหัสในฐานข้อมูล
    if (!user || !(await bcrypt.compare(password, user.password_hash))) 
      return res.status(400).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    
    // สร้าง JWT Token โดยกำหนดให้มีอายุการใช้งาน 1 วัน
    const token = jwt.sign({ id: user.id, name: user.name, has_completed_quiz: user.has_completed_quiz }, SECRET_KEY, { expiresIn: '1d' });
    
    // ส่ง Token และข้อมูลผู้ใช้ที่จำเป็นกลับไปให้หน้าบ้าน
    res.json({ token, user: { id: user.id, name: user.name, has_completed_quiz: user.has_completed_quiz } });
    
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

// พาทสำหรับตรวจสอบสถานะผู้ใช้งานปัจจุบันผ่าน Token
app.get('/api/verify', verifyToken, async (req, res) => {
  try {
    // 🟢 เปลี่ยนมาใช้ pool.query และเปลี่ยน ? เป็น $1
    const result = await pool.query(
      `SELECT id, name, has_completed_quiz FROM users WHERE id = $1`, 
      [req.user.id]
    );
    
    const user = result.rows[0]; // ดึงข้อมูลผู้ใช้แถวแรก
    res.json({ valid: true, user });
    
  } catch (error) {
    console.error('Verify Token Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

// --- ระบบบันทึกและคำนวณความพึงพอใจ (Preference & Quiz Routes) ---

// อัปเดตสถานะการทำแบบทดสอบแรกเริ่มของผู้ใช้ว่าเสร็จสิ้นแล้ว
app.post('/api/users/complete-quiz', verifyToken, async (req, res) => {
  try {
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL และเปลี่ยน ? เป็น $1
    await pool.query(
      `UPDATE users SET has_completed_quiz = 1 WHERE id = $1`, 
      [req.user.id]
    );
    
    res.json({ message: 'Success' });
    
  } catch (error) {
    console.error('Complete Quiz Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

// บันทึกหรือคำนวณคะแนนความพึงพอใจตามประเภทหนัง (Genre Preferences)
app.post('/api/update-preference', verifyToken, async (req, res) => {
  const { key, score } = req.body;
  
  try {
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL 
    // 🟢 เปลี่ยนเครื่องหมาย ? ทั้ง 4 ตัว เป็น $1, $2, $3, $4 ตามลำดับ
    await pool.query(
      `INSERT INTO user_preferences (user_id, pref_key, pref_value) 
       VALUES ($1, $2, $3) 
       ON CONFLICT(user_id, pref_key) 
       DO UPDATE SET pref_value = pref_value + $4`, 
      [req.user.id, key, score, score]
    );
    
    res.json({ message: 'Updated' });
    
  } catch (error) {
    console.error('Update Preference Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

// --- ระบบจัดการรายการที่ชอบและไม่ชอบ (Likes Management) ---

// พาทสำหรับบันทึกภาพยนตร์ที่ผู้ใช้กดถูกใจ (Like) หรือไม่ถูกใจ (Dislike)
app.post('/api/likes', verifyToken, async (req, res) => {
  const { film_id, film_title, type } = req.body;
  const userId = req.user.id;

  try {
    // 🟢 สเตปที่ 1: ตรวจสอบว่าเคยมีการบันทึกภาพยนตร์เรื่องนี้ไปแล้วหรือไม่
    const checkResult = await pool.query(
      `SELECT id FROM user_likes WHERE user_id = $1 AND film_id = $2`, 
      [userId, film_id]
    );
    
    const row = checkResult.rows[0];

    // 🟢 สเตปที่ 2: ถ้ามีข้อมูลอยู่แล้วให้ทำการอัปเดตสถานะ
    if (row) {
      await pool.query(
        `UPDATE user_likes SET type = $1 WHERE id = $2`, 
        [type, row.id]
      );
    } 
    // 🟢 สเตปที่ 3: ถ้ายังไม่มีข้อมูลให้ทำการบันทึกข้อมูลใหม่
    else {
      await pool.query(
        `INSERT INTO user_likes (user_id, film_id, film_title, type) VALUES ($1, $2, $3, $4)`, 
        [userId, film_id, film_title, type]
      );
    }

    res.json({ message: 'Saved' });

  } catch (error) {
    console.error('Save Like/Dislike Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบฐานข้อมูล' });
  }
});

// พาทสำหรับดึงรายการภาพยนตร์ที่ชอบและไม่ชอบทั้งหมดของผู้ใช้ออกมาแสดงผล
app.get('/api/likes', verifyToken, async (req, res) => {
  try {
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL และเปลี่ยน ? เป็น $1
    const result = await pool.query(
      `SELECT film_id, film_title, type FROM user_likes WHERE user_id = $1`, 
      [req.user.id]
    );
    
    const rows = result.rows; // ดึงข้อมูลแถวทั้งหมดจากผลลัพธ์

    // คัดกรองข้อมูลออกเป็นสองกลุ่มตามประเภทเพื่อส่งกลับไปให้หน้าบ้านแสดงผลในแต่ละแท็บ
    const liked = rows ? rows.filter(row => row.type === 'like') : [];
    const disliked = rows ? rows.filter(row => row.type === 'dislike') : [];
    
    res.json({ liked, disliked });
    
  } catch (error) {
    console.error('Get Likes Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
  }
});

// พาทสำหรับลบภาพยนตร์ออกจากคอลเลกชัน
app.delete('/api/likes/:film_id', verifyToken, async (req, res) => {
  const userId = req.user.id;
  const filmId = req.params.film_id;

  try {
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL และเปลี่ยน ? เป็น $1, $2
    await pool.query(
      `DELETE FROM user_likes WHERE user_id = $1 AND film_id = $2`, 
      [userId, filmId]
    );
    
    res.json({ message: 'ยกเลิกรายการเรียบร้อยแล้ว' });
    
  } catch (error) {
    console.error('Delete Like Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในการลบข้อมูล' });
  }
});

// --- ระบบจัดการห้องสำหรับจับคู่ภาพยนตร์กลุ่ม (Room Routes) ---

// สร้างห้องใหม่และกำหนดรหัสผ่านสุ่ม 4 หลัก (PIN)
app.post('/api/create-room', verifyToken, async (req, res) => {
  const pin = Math.floor(1000 + Math.random() * 9000).toString();
  
  try {
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL และเปลี่ยน ? เป็น $1, $2
    await pool.query(
      `INSERT INTO rooms (pin, host_id, status) VALUES ($1, $2, 'waiting')`, 
      [pin, req.user.id]
    );
    
    res.json({ pin });
    
  } catch (error) {
    console.error('Create Room Error:', error);
    res.status(500).json({ message: 'สร้างห้องไม่สำเร็จ' });
  }
});

// ดึงสถานะปัจจุบันของห้องและชื่อผู้สร้างห้องผ่านรหัส PIN
app.get('/api/room-status/:pin', verifyToken, async (req, res) => {
  const pin = req.params.pin;

  try {
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL และเปลี่ยน ? เป็น $1
    const result = await pool.query(
      `SELECT r.status, u.name as host FROM rooms r JOIN users u ON r.host_id = u.id WHERE r.pin = $1`, 
      [pin]
    );
    
    const row = result.rows[0]; // ดึงข้อมูลแถวแรก

    if (!row) return res.status(404).json({ message: 'ไม่พบห้อง' });
    
    res.json(row);
    
  } catch (error) {
    console.error('Get Room Status Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});


// อัปเดตสถานะห้องเมื่อผู้สร้างห้องกดเริ่มกระบวนการสุ่มจับคู่ภาพยนตร์
app.post('/api/start-room', verifyToken, async (req, res) => {
  const { pin } = req.body;

  try {
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL และเปลี่ยน ? เป็น $1
    await pool.query(
      `UPDATE rooms SET status = 'started' WHERE pin = $1`, 
      [pin]
    );
    
    res.json({ message: 'Started' });
    
  } catch (error) {
    console.error('Start Room Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

// ลบห้องออกจากระบบเมื่อผู้สร้างห้องหรือสมาชิกออกจากห้อง
app.delete('/api/leave-room/:pin', verifyToken, async (req, res) => {
  const pin = req.params.pin;

  try {
    // 🟢 เปลี่ยนมาใช้ pool.query สำหรับ PostgreSQL และเปลี่ยน ? เป็น $1
    await pool.query(
      `DELETE FROM rooms WHERE pin = $1`, 
      [pin]
    );
    
    res.json({ message: 'Left' });
    
  } catch (error) {
    console.error('Leave Room Error:', error);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในการออกจากห้อง' });
  }
});

// เปิดการทำงานเซิร์ฟเวอร์หลังบ้านตามพอร์ตที่กำหนด
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});