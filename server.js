const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const SECRET_KEY = 'cinematch_super_secret_key';

// ==========================================
// 1. เชื่อมต่อและสร้างตาราง SQLite
// ==========================================
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('เกิดข้อผิดพลาดในการเชื่อมต่อ SQLite:', err.message);
    else console.log('เชื่อมต่อฐานข้อมูล SQLite สำเร็จแล้ว!');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        has_completed_quiz INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        movie_id TEXT,
        action TEXT,
        media_type TEXT,
        movie_title TEXT,
        poster_path TEXT, 
        genres TEXT,
        points INTEGER
    )`);
});

// Middleware สำหรับตรวจสอบ Token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Access Denied' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid Token' });
        req.user = user;
        next();
    });
};

// ==========================================
// 2. ระบบ Auth (สมัครสมาชิก & ล็อกอิน)
// ==========================================
app.post('/api/register', (req, res) => {
    const { name, email, password } = req.body;
    db.run(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`, [name, email, password], function(err) {
        if (err) {
            // ✅ เพิ่ม 2 บรรทัดนี้ เพื่อให้มันปริ้นท์บอกว่า Error อะไร
            console.error("🔥 SQLite Error:", err.message); 
            
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ message: 'มีอีเมลนี้ในระบบแล้ว' });
            }
            // ✅ ส่งข้อความ Error ไปโชว์ที่หน้าเว็บด้วย จะได้ไม่งง
            return res.status(500).json({ message: 'Database error: ' + err.message }); 
        }
        
        const token = jwt.sign({ id: this.lastID, name, email }, SECRET_KEY);
        res.status(201).json({ 
            token, 
            user: { id: this.lastID, name, email, has_completed_quiz: 0 } 
        });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password], (err, user) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        if (!user) return res.status(400).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });

        const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, SECRET_KEY);
        res.status(200).json({ 
            token, 
            user: { id: user.id, name: user.name, email: user.email, has_completed_quiz: user.has_completed_quiz } 
        });
    });
});

// API สำหรับอัปเดตสถานะว่าทำควิซเสร็จแล้ว (App.jsx เรียกใช้ตอนจบ Quiz)
app.post('/api/users/complete-quiz', authenticateToken, (req, res) => {
    const userId = req.user.id;
    db.run(`UPDATE users SET has_completed_quiz = 1 WHERE id = ?`, [userId], function(err) {
        if (err) return res.status(500).json({ message: 'Update failed' });
        res.status(200).json({ message: 'Quiz status updated' });
    });
});

// ==========================================
// 3. ระบบ Like / Dislike ภาพยนตร์ (อัปเดตแก้บั๊ก)
// ==========================================

// บันทึกความชอบลงฐานข้อมูล (ป้องกันข้อมูลซ้ำ + เก็บหน้าปกหนัง)
app.post('/api/likes', authenticateToken, (req, res) => {
    const { movie_id, film_id, action, type, media_type, movie_title, film_title, genres, points, poster_path } = req.body;
    const userId = req.user.id;
    
    const finalMovieId = movie_id || film_id; 
    const finalAction = action || type;
    const finalTitle = movie_title || film_title || null;
    const finalPoster = poster_path || null;
    const finalGenres = genres || null;
    const finalPoints = points || 0;

    // เช็กข้อมูลซ้ำ
    const checkQuery = `SELECT id FROM user_likes WHERE user_id = ? AND movie_id = ?`;
    
    db.get(checkQuery, [userId, finalMovieId], (err, row) => {
        if (err) return res.status(500).json({ message: "Database Error" });
        
        if (row) {
            // อัปเดตของเดิม
            const updateQuery = `UPDATE user_likes SET action = ?, media_type = ?, movie_title = ?, poster_path = ?, genres = ?, points = ? WHERE id = ?`;
            db.run(updateQuery, [finalAction, media_type || 'movie', finalTitle, finalPoster, finalGenres, finalPoints, row.id], function(updateErr) {
                if (updateErr) return res.status(500).json({ message: "Update Error" });
                return res.status(200).json({ message: "อัปเดตข้อมูลสำเร็จ" });
            });
        } else {
            // สร้างใหม่
            const insertQuery = `INSERT INTO user_likes (user_id, movie_id, action, media_type, movie_title, poster_path, genres, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            db.run(insertQuery, [userId, finalMovieId, finalAction, media_type || 'movie', finalTitle, finalPoster, finalGenres, finalPoints], function(insertErr) {
                if (insertErr) return res.status(500).json({ message: "Insert Error" });
                res.status(200).json({ message: "บันทึกสำเร็จ" });
            });
        }
    });
});

app.get('/api/likes', authenticateToken, (req, res) => {
    const userId = req.user.id;
    // ✅ ส่ง media_type กลับไปให้หน้าบ้านด้วย
    db.all(`SELECT movie_id, action, media_type FROM user_likes WHERE user_id = ?`, [userId], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.status(200).json(rows);
    });
});

// สร้าง API สำหรับลบรายการออกจาก Collection โดยเฉพาะ (แก้บั๊กตอนกดกากบาท)
app.delete('/api/likes/:movie_id', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const movieId = req.params.movie_id;
    
    db.run(`DELETE FROM user_likes WHERE user_id = ? AND movie_id = ?`, [userId, movieId], function(err) {
        if (err) return res.status(500).json({ message: 'Delete error' });
        res.status(200).json({ message: 'ลบข้อมูลสำเร็จ' });
    });
});

// ==========================================
// 4. ระบบ API สำหรับหน้า Home (Recommendation Engine ของจริง)
// ==========================================

const TMDB_GENRE_MAP = {
    28: "Action", 12: "Action", 16: "Comedy", 35: "Comedy", 80: "Mystery",
    99: "Drama", 18: "Drama", 10751: "Comedy", 14: "SciFi", 36: "Drama",
    27: "Horror", 10402: "Romance", 9648: "Mystery", 10749: "Romance", 878: "SciFi",
    10770: "Drama", 53: "Mystery", 10752: "Action", 37: "Action"
};

// ==========================================
// แนะนำภาพยนตร์รายบุคคล (สำหรับหน้า Home.jsx Top 10 For You)
// ==========================================
app.post('/api/recommendations', authenticateToken, async (req, res) => {
    try {
        const userWeights = req.body.genreWeights || {};
        
        // ถ้าผู้ใช้ยังไม่มีข้อมูลความชอบเลย ให้ส่งลิสต์ว่างไปก่อน (เดี๋ยวหน้าบ้านใช้ Fallback)
        if (Object.keys(userWeights).length === 0) {
            return res.status(200).json([]);
        }

        const REVERSE_GENRE_MAP = {
            "แอคชั่นบู้ล้างผลาญ": 28, "ผจญภัย": 12, "แอนิเมชัน": 16, "ตลกขบขัน": 35, "อาชญากรรม": 80,
            "สารคดี": 99, "ดราม่าเข้มข้น": 18, "ครอบครัว": 10751, "แฟนตาซีเวทมนตร์": 14, "ประวัติศาสตร์": 36,
            "สยองขวัญ": 27, "มิวสิคัล": 10402, "ลึกลับซ่อนเงื่อน": 9648, "โรแมนติก": 10749, "ไซไฟอวกาศ": 878,
            "ทีวีมูฟวี่": 10770, "ระทึกขวัญตื่นเต้น": 53, "สงคราม": 10752, "คาวบอยตะวันตก": 37
        };

        // 1. หาหมวดหมู่ Top 3 ของผู้ใช้คนนี้
        const topGenres = Object.entries(userWeights)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3) 
            .map(([name]) => REVERSE_GENRE_MAP[name])
            .filter(id => id);

        // 2. ใช้ OR (|) แทน AND (,) เพื่อกวาดข้อมูลให้กว้างขึ้น
        const genreQuery = topGenres.length > 0 ? `&with_genres=${topGenres.join('|')}` : '';
        const API_KEY = "181edc5801db6678de6ccb2864149a6a";

        // 3. DEEP FETCHING: ดึงทั้งหนังและซีรีส์ 3 หน้า
        const fetchPromises = [];
        for (let page = 1; page <= 3; page++) {
            fetchPromises.push(fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${API_KEY}&language=th-TH&sort_by=popularity.desc${genreQuery}&page=${page}`));
            fetchPromises.push(fetch(`https://api.themoviedb.org/3/discover/tv?api_key=${API_KEY}&language=th-TH&sort_by=popularity.desc${genreQuery}&page=${page}`));
        }

        const responses = await Promise.all(fetchPromises);
        const dataJsons = await Promise.all(responses.map(res => res.json()));

        let allItems = [];
        dataJsons.forEach((data, index) => {
            const isTV = index % 2 !== 0; 
            const formatted = (data.results || []).map(item => ({
                ...item,
                title: isTV ? item.name : item.title,
                release_date: isTV ? item.first_air_date : item.release_date,
                media_type: isTV ? 'tv' : 'movie'
            }));
            allItems = [...allItems, ...formatted];
        });

        // 4. SCORING ENGINE: ให้คะแนนหนังทุกเรื่องตามคะแนนใน Local Storage
        const scoredItems = allItems.map(item => {
            let matchScore = 0; 
            if (item.genre_ids) {
                item.genre_ids.forEach(id => {
                    const genreNameKey = Object.keys(REVERSE_GENRE_MAP).find(k => REVERSE_GENRE_MAP[k] === id);
                    if (genreNameKey && userWeights[genreNameKey]) {
                        matchScore += userWeights[genreNameKey];
                    }
                });
            }
            return { ...item, rawScore: matchScore };
        });

        // 5. SORT & FILTER: ตัดเรื่องซ้ำและเรียงคะแนน
        scoredItems.sort((a, b) => b.rawScore - a.rawScore);

        const uniqueItems = [];
        const seenIds = new Set();
        for (const item of scoredItems) {
            // เอาเฉพาะที่มีหน้าปก และคะแนน > 0
            if (!seenIds.has(item.id) && item.poster_path && item.backdrop_path && item.rawScore > 0) {
                seenIds.add(item.id);
                uniqueItems.push(item);
            }
        }

        // 6. PERCENTAGE CONVERSION (บัญญัติไตรยางค์)
        const topScore = uniqueItems[0]?.rawScore || 1; 
        const finalResults = uniqueItems.map((item, index) => {
            let percent = 98; 
            if (index > 0) {
                percent = Math.floor((item.rawScore * 98) / topScore);
                if (percent >= 98) percent = 98 - index; 
            }
            return { ...item, matchPercent: percent };
        });

        // คืนค่า Top 10 ไปให้หน้า Home.jsx แสดงผล
        res.status(200).json(finalResults.slice(0, 10));

    } catch (err) {
        console.error("Recommendations Error:", err);
        res.status(500).json({ message: "เกิดข้อผิดพลาดในการประมวลผลคำแนะนำ" });
    }
});

// ==========================================
// 5. ระบบ Duo Match (สร้างห้องและจับคู่)
// ==========================================

// ใช้ Object เก็บข้อมูลห้องชั่วคราวใน Memory (ทำงานเร็วและเหมาะกับการใช้งานระยะสั้น)
const activeRooms = {}; 

// 5.1 สร้างห้อง (Host)
app.post('/api/rooms/create', authenticateToken, (req, res) => {
    const { hostName, genreWeights } = req.body;
    
    // สุ่มรหัส PIN 6 หลัก
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    // สร้างห้องใหม่และบันทึกคะแนนของ Host เอาไว้
    activeRooms[pin] = {
        pin,
        host: { name: hostName, weights: genreWeights || {} },
        guest: null,
        status: 'waiting', // สถานะ: รอเพื่อนเข้าห้อง
        results: null
    };

    res.status(200).json({ pin });
});

// 5.2 เข้าร่วมห้อง (Guest)
app.post('/api/rooms/join', authenticateToken, (req, res) => {
    const { pin, guestName, genreWeights } = req.body;

    if (!activeRooms[pin]) return res.status(404).json({ message: 'ไม่พบรหัสห้องนี้ หรือห้องหมดอายุแล้ว' });
    if (activeRooms[pin].guest) return res.status(400).json({ message: 'ห้องนี้เต็มแล้ว' });

    // บันทึกคะแนนของ Guest ลงในห้อง
    activeRooms[pin].guest = { name: guestName, weights: genreWeights || {} };
    activeRooms[pin].status = 'ready'; // สถานะ: เพื่อนเข้าแล้ว พร้อมประมวลผล

    res.status(200).json({ message: 'เข้าร่วมห้องสำเร็จ', hostName: activeRooms[pin].host.name });
});

// 5.3 เช็กสถานะห้อง (หน้าบ้านจะยิง API นี้มาเช็กเรื่อยๆ ว่าเพื่อนเข้าหรือยัง)
app.get('/api/rooms/status/:pin', authenticateToken, (req, res) => {
    const { pin } = req.params;
    if (!activeRooms[pin]) return res.status(404).json({ message: 'ไม่พบห้อง' });

    res.status(200).json({ 
        status: activeRooms[pin].status,
        hostName: activeRooms[pin].host.name,
        guestName: activeRooms[pin].guest ? activeRooms[pin].guest.name : null,
        results: activeRooms[pin].results
    });
});

// 5.4 ประมวลผลหาหนังที่ใช่สำหรับ 2 คน (Deep Fetching & Scoring Engine)
// ==========================================
// เครื่องยนต์หลัก: Data Integration & Duo Match
// ==========================================
app.post('/api/rooms/match/:pin', authenticateToken, async (req, res) => {
    const { pin } = req.params;
    const room = activeRooms[pin];

    if (!room || room.status !== 'ready') {
        return res.status(400).json({ message: 'ห้องยังไม่พร้อมสำหรับการประมวลผล' });
    }

    try {
        const hostWeights = room.host.weights || {};
        const guestWeights = room.guest.weights || {};

        // 🟢 1. DATA INTEGRATION: หลอมรวมความชอบของ 2 คน
        const combinedWeights = {};
        const allKeys = new Set([...Object.keys(hostWeights), ...Object.keys(guestWeights)]);
        
        allKeys.forEach(key => {
            combinedWeights[key] = (hostWeights[key] || 0) + (guestWeights[key] || 0);
        });

        console.log(`\n====== 🧠 ประมวลผลห้อง PIN: ${pin} ======`);
        console.log("📊 ค่าน้ำหนักรวม (Combined Weights):", combinedWeights);

        const REVERSE_GENRE_MAP = {
            "แอคชั่นบู้ล้างผลาญ": 28, "ผจญภัย": 12, "แอนิเมชัน": 16, "ตลกขบขัน": 35, "อาชญากรรม": 80,
            "สารคดี": 99, "ดราม่าเข้มข้น": 18, "ครอบครัว": 10751, "แฟนตาซีเวทมนตร์": 14, "ประวัติศาสตร์": 36,
            "สยองขวัญ": 27, "มิวสิคัล": 10402, "ลึกลับซ่อนเงื่อน": 9648, "โรแมนติก": 10749, "ไซไฟอวกาศ": 878,
            "ทีวีมูฟวี่": 10770, "ระทึกขวัญตื่นเต้น": 53, "สงคราม": 10752, "คาวบอยตะวันตก": 37
        };

        // 🟢 2. ดึง 3 หมวดหมู่ที่คะแนนรวมสูงสุด เพื่อไปใช้ดึงข้อมูลจาก TMDB
        const topGenres = Object.entries(combinedWeights)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3) 
            .map(([name]) => REVERSE_GENRE_MAP[name])
            .filter(id => id);

        const genreQuery = topGenres.length > 0 ? `&with_genres=${topGenres.join('|')}` : '';
        const API_KEY = "181edc5801db6678de6ccb2864149a6a";

        // 🟢 3. HYBRID FETCH: ดึงทั้งภาพยนตร์และซีรีส์จำนวน 5 หน้า (ราวๆ 200 เรื่อง)
        const fetchPromises = [];
        for (let page = 1; page <= 5; page++) {
            fetchPromises.push(fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${API_KEY}&language=th-TH&sort_by=popularity.desc${genreQuery}&page=${page}`));
            fetchPromises.push(fetch(`https://api.themoviedb.org/3/discover/tv?api_key=${API_KEY}&language=th-TH&sort_by=popularity.desc${genreQuery}&page=${page}`));
        }

        const responses = await Promise.all(fetchPromises);
        const dataJsons = await Promise.all(responses.map(res => res.json()));

        let allItems = [];
        dataJsons.forEach((data, index) => {
            const isTV = index % 2 !== 0; 
            const formatted = (data.results || []).map(item => ({
                ...item,
                title: isTV ? item.name : item.title, // รวมชื่อให้เป็น title เดียวกัน
                release_date: isTV ? item.first_air_date : item.release_date,
                media_type: isTV ? 'tv' : 'movie'
            }));
            allItems = [...allItems, ...formatted];
        });

        // 🟢 4. SCORING ENGINE: ให้คะแนนหนังทุกเรื่องตามจุดร่วมความชอบ
        const scoredItems = allItems.map(item => {
            let matchScore = 0; 
            if (item.genre_ids) {
                item.genre_ids.forEach(id => {
                    // แปลงรหัส TMDB กลับเป็นชื่อภาษาไทย เพื่อเทียบกับคะแนน
                    const genreNameKey = Object.keys(REVERSE_GENRE_MAP).find(k => REVERSE_GENRE_MAP[k] === id);
                    if (genreNameKey && combinedWeights[genreNameKey]) {
                        // ถ้าหนังมีหมวดหมู่ตรงกับที่ผู้ใช้ชอบ ให้บวกคะแนนเพิ่ม
                        matchScore += combinedWeights[genreNameKey];
                    }
                });
            }
            return { ...item, rawScore: matchScore };
        });

        // 🟢 5. FILTER & SORT: เรียงคะแนนจากมากไปน้อย และคัดเรื่องซ้ำออก
        scoredItems.sort((a, b) => b.rawScore - a.rawScore);

        const uniqueItems = [];
        const seenIds = new Set();
        for (const item of scoredItems) {
            // เอาเฉพาะเรื่องที่มีหน้าปกและคะแนนมากกว่า 0
            if (!seenIds.has(item.id) && item.poster_path && item.backdrop_path && item.rawScore > 0) {
                seenIds.add(item.id);
                uniqueItems.push(item);
            }
        }

        // 🟢 6. MATCH PERCENTAGE (บัญญัติไตรยางค์) & ตัดเลือก Top 10
        const topScore = uniqueItems[0]?.rawScore || 1; 
        
        const finalResults = uniqueItems.map((item, index) => {
            let percent = 98; 
            if (index > 0) {
                percent = Math.floor((item.rawScore * 98) / topScore);
                // ป้องกันกรณีเปอร์เซ็นต์เท่ากันเกินไป ให้ลดหลั่นทีละอันดับ
                if (percent >= 98) percent = 98 - index; 
            }
            return { ...item, matchPercent: percent };
        });

        room.results = finalResults.slice(0, 10); // เก็บแค่ 10 อันดับแรก
        room.status = 'completed';

        console.log(`✅ ประมวลผลเสร็จสิ้น! ได้ Top 10 แนะนำสำหรับห้อง ${pin}`);
        res.status(200).json(room.results);

    } catch (err) {
        console.error("Duo Match Error:", err);
        res.status(500).json({ message: "เกิดข้อผิดพลาดในการประมวลผล" });
    }
});

// ==========================================
// เริ่มต้นรันเซิร์ฟเวอร์
// ==========================================
app.listen(5000, () => {
    console.log('Backend server running on port 5000');
});