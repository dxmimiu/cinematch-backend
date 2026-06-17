const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); 
const db = require('./database'); 

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = 'cinematch_super_secret_key'; 

app.use(cors()); 
app.use(express.json()); 

// Middleware ตรวจสอบ Token
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(403).json({ message: 'ไม่มี Token อนุญาตให้เข้าถึง' });

  const token = authHeader.split(' ')[1]; 
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ message: 'Token ไม่ถูกต้องหรือหมดอายุแล้ว' });
    req.user = decoded;
    next();
  });
};

// --- Auth Routes ---
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });

  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    db.run(`INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`, [name, email, passwordHash], function(err) {
      if (err) return res.status(400).json({ message: 'อีเมลนี้มีในระบบแล้ว' });
      res.status(201).json({ message: 'สมัครสมาชิกเรียบร้อย' });
    });
  } catch (error) {
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (!user || !(await bcrypt.compare(password, user.password_hash))) 
      return res.status(400).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    
    const token = jwt.sign({ id: user.id, name: user.name, has_completed_quiz: user.has_completed_quiz }, SECRET_KEY, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, name: user.name, has_completed_quiz: user.has_completed_quiz } });
  });
});

app.get('/api/verify', verifyToken, (req, res) => {
  db.get(`SELECT id, name, has_completed_quiz FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    res.json({ valid: true, user });
  });
});

// --- Preference & Quiz Routes ---
app.post('/api/users/complete-quiz', verifyToken, (req, res) => {
  db.run(`UPDATE users SET has_completed_quiz = 1 WHERE id = ?`, [req.user.id], () => res.json({ message: 'Success' }));
});

app.post('/api/update-preference', verifyToken, (req, res) => {
  const { key, score } = req.body;
  db.run(`INSERT INTO user_preferences (user_id, pref_key, pref_value) VALUES (?, ?, ?) 
          ON CONFLICT(user_id, pref_key) DO UPDATE SET pref_value = pref_value + ?`, 
          [req.user.id, key, score, score]);
  res.json({ message: 'Updated' });
});

// --- Likes Management ---
app.post('/api/likes', verifyToken, (req, res) => {
  const { film_id, film_title, type } = req.body;
  db.get(`SELECT id FROM user_likes WHERE user_id = ? AND film_id = ?`, [req.user.id, film_id], (err, row) => {
    if (row) db.run(`UPDATE user_likes SET type = ? WHERE id = ?`, [type, row.id]);
    else db.run(`INSERT INTO user_likes (user_id, film_id, film_title, type) VALUES (?, ?, ?, ?)`, [req.user.id, film_id, film_title, type]);
    res.json({ message: 'Saved' });
  });
});

// --- Room Routes ---
app.post('/api/create-room', verifyToken, (req, res) => {
  const pin = Math.floor(1000 + Math.random() * 9000).toString();
  db.run(`INSERT INTO rooms (pin, host_id, status) VALUES (?, ?, 'waiting')`, [pin, req.user.id], (err) => {
    if (err) return res.status(500).json({ message: 'สร้างห้องไม่สำเร็จ' });
    res.json({ pin });
  });
});

app.get('/api/room-status/:pin', verifyToken, (req, res) => {
  db.get(`SELECT r.status, u.name as host FROM rooms r JOIN users u ON r.host_id = u.id WHERE r.pin = ?`, [req.params.pin], (err, row) => {
    if (!row) return res.status(404).json({ message: 'ไม่พบห้อง' });
    res.json(row);
  });
});

app.post('/api/start-room', verifyToken, (req, res) => {
  db.run(`UPDATE rooms SET status = 'started' WHERE pin = ?`, [req.body.pin], () => res.json({ message: 'Started' }));
});

app.delete('/api/leave-room/:pin', verifyToken, (req, res) => {
  db.run(`DELETE FROM rooms WHERE pin = ?`, [req.params.pin], () => res.json({ message: 'Left' }));
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});