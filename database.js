const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres.epaeevxsvmfoeqpufhvr:cinematch2310511101020@aws-1-ap-south-1.pooler.supabase.com:6543/postgres',
});

// ฟังก์ชันสำหรับทดสอบเชื่อมต่อ
pool.connect((err, client, release) => {
  if (err) {
    return console.error('เชื่อมต่อ Supabase ไม่สำเร็จ:', err.stack);
  }
  console.log('🔗 เชื่อมต่อฐานข้อมูล Supabase (PostgreSQL) สำเร็จ!');
  release();
});

// ฟังก์ชันกลางสำหรับรันคำสั่ง Query (แทนคำสั่ง .run หรือ .all ของ sqlite)
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (error) {
    console.error('Database Query Error:', error);
    throw error;
  }
};

module.exports = {
  query,
  pool
};