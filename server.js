const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json());

const SECRET_KEY = 'cinematch_super_secret_key';

// ==========================================
// 1. เชื่อมต่อฐานข้อมูล Supabase (PostgreSQL)
// ==========================================
const { pool } = require('./database'); // ดึง pool มาจากไฟล์ database.js ที่เราแก้ไว้ก่อนหน้านี้

// ตรวจสอบความพร้อมผ่านการ query เบื้องต้น
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('เกิดข้อผิดพลาดในการเชื่อมต่อฐานข้อมูล:', err.message);
    } else {
        console.log('เชื่อมต่อฐานข้อมูล PostgreSQL บน Cloud (Supabase) สำเร็จแล้ว!');
    }
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
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });

    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        
        const result = await pool.query(
            `INSERT INTO users (name, email, password, has_completed_quiz) VALUES ($1, $2, $3, 0) RETURNING id`, 
            [name, email, passwordHash]
        );
        
        const userId = result.rows[0].id;
        const token = jwt.sign({ id: userId, name, email }, SECRET_KEY);
        
        res.status(201).json({ 
            token, 
            user: { id: userId, name, email, has_completed_quiz: 0 } 
        });
    } catch (err) {
        console.error("🔥 Database Error:", err.message); 
        return res.status(400).json({ message: 'มีอีเมลนี้ในระบบแล้ว หรือเกิดข้อผิดพลาด' }); 
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
        }

        const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, SECRET_KEY);
        res.status(200).json({ 
            token, 
            user: { id: user.id, name: user.name, email: user.email, has_completed_quiz: user.has_completed_quiz } 
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ message: 'Database error' });
    }
});

// 🟢 API ใหม่: บันทึกค่าน้ำหนักคะแนนหมวดหมู่ (Genre Weights) จาก Preference Quiz ลง Cloud
app.post('/api/preferences', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { genreWeights } = req.body; // รับ Object เช่น {"แอนิเมชัน": 15, "สยองขวัญ": 8} จากหน้าบ้าน

    if (!genreWeights || Object.keys(genreWeights).length === 0) {
        return res.status(400).json({ message: "ไม่มีข้อมูลคะแนนความชอบส่งมา" });
    }

    try {
        // วนลูปบันทึกหรืออัปเดตคะแนนทีละหมวดหมู่ลงฐานข้อมูล Supabase
        for (const [genreName, score] of Object.entries(genreWeights)) {
            await pool.query(
                `INSERT INTO user_preferences (user_id, pref_key, pref_value) 
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, pref_key) 
                 DO UPDATE SET pref_value = EXCLUDED.pref_value`, // ถ้าเคยมีหมวดหมู่นี้แล้ว ให้อัปเดตคะแนนทับเลย
                [userId, genreName, score]
            );
        }
        res.status(200).json({ message: 'บันทึกคะแนนความชอบลง Cloud สำเร็จแล้ว' });
    } catch (err) {
        console.error("Save Preferences Error:", err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการบันทึกคะแนนลงคลังข้อมูล' });
    }
});

// API สำหรับอัปเดตสถานะว่าทำควิซเสร็จแล้ว (App.jsx เรียกใช้ตอนจบ Quiz)
app.post('/api/users/complete-quiz', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        await pool.query(`UPDATE users SET has_completed_quiz = 1 WHERE id = $1`, [userId]);
        res.status(200).json({ message: 'Quiz status updated' });
    } catch (err) {
        console.error("Update Quiz Error:", err);
        res.status(500).json({ message: 'Update failed' });
    }
});

// ==========================================
// 3. ระบบ Like / Dislike ภาพยนตร์ (อัปเดตแก้บั๊ก)
// ==========================================

// บันทึกความชอบลงฐานข้อมูล (ป้องกันข้อมูลซ้ำ + เก็บหน้าปกหนัง)
// บันทึกความชอบภาพยนตร์ / ผลจากมินิเกม พร้อมเก็บคะแนนลง Cloud
app.post('/api/likes', authenticateToken, async (req, res) => {
    const { movie_id, film_id, action, type, media_type, movie_title, film_title, genres, points, poster_path } = req.body;
    const userId = req.user.id;
    
    const finalMovieId = movie_id || film_id; 
    const finalAction = action || type;
    const finalTitle = movie_title || film_title || null;
    const finalPoster = poster_path || null;
    const finalGenres = genres || null;
    
    // 🟢 ดึงค่าคะแนนที่ส่งมาจากหน้าบ้าน ถ้าไม่มีค่อยให้เป็น 0
    const finalPoints = parseInt(points) || 0; 

    try {
        const checkResult = await pool.query(
            `SELECT id FROM user_likes WHERE user_id = $1 AND movie_id = $2`, 
            [userId, finalMovieId]
          );
          
          if (checkResult.rows.length > 0) {
              // อัปเดตของเดิม (รวมถึงอัปเดตคะแนนใหม่ที่ได้จากเกม)
              await pool.query(
                  `UPDATE user_likes SET action = $1, media_type = $2, movie_title = $3, poster_path = $4, genres = $5, points = $6 WHERE id = $7`, 
                  [finalAction, media_type || 'movie', finalTitle, finalPoster, finalGenres, finalPoints, checkResult.rows[0].id]
              );
              return res.status(200).json({ message: "อัปเดตข้อมูลและคะแนนสำเร็จ" });
          } else {
              // บันทึกรายการใหม่พร้อมคะแนนลงตาราง user_likes
              await pool.query(
                  `INSERT INTO user_likes (user_id, movie_id, action, media_type, movie_title, poster_path, genres, points) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
                  [userId, finalMovieId, finalAction, media_type || 'movie', finalTitle, finalPoster, finalGenres, finalPoints]
              );
              return res.status(200).json({ message: "บันทึกข้อมูลและคะแนนสำเร็จ" });
          }
    } catch (err) {
        console.error("Likes Post Error:", err);
        return res.status(500).json({ message: "Database Error" });
    }
});

app.get('/api/likes', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query(
            `SELECT movie_id, action, media_type FROM user_likes WHERE user_id = $1`, 
            [userId]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Likes Get Error:", err);
        res.status(500).json({ message: 'Database error' });
    }
});

// สร้าง API สำหรับลบรายการออกจาก Collection โดยเฉพาะ (แก้บั๊กตอนกดกากบาท)
app.delete('/api/likes/:movie_id', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const movieId = req.params.movie_id;

    try {
        await pool.query(
            `DELETE FROM user_likes WHERE user_id = $1 AND movie_id = $2`, 
            [userId, movieId]
        );
        res.status(200).json({ message: 'ลบข้อมูลสำเร็จ' });
    } catch (err) {
        console.error("Delete Like Error:", err);
        res.status(500).json({ message: 'Delete error' });
    }
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
// แนะนำภาพยนตร์รายบุคคล (ดึงคะแนนโดยตรงจากคลังข้อมูลบน Cloud)
app.post('/api/recommendations', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // 🟢 เปลี่ยนมาดึงค่าน้ำหนักคะแนนจากตาราง user_preferences บน Supabase
        const prefResult = await pool.query(
            `SELECT pref_key, pref_value FROM user_preferences WHERE user_id = $1`,
            [userId]
        );

        let userWeights = {};
        if (prefResult.rows.length > 0) {
            // ดึงคะแนนจากฐานข้อมูลมาจัดโครงสร้างใหม่
            prefResult.rows.forEach(row => {
                userWeights[row.pref_key] = row.pref_value;
            });
        } else {
            // Fallback: ถ้าใน Cloud ยังไม่มีข้อมูล ให้ลองใช้ค่าที่หน้าบ้านส่งมาเผื่อไว้
            userWeights = req.body.genreWeights || {};
        }
        
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

        const genreQuery = topGenres.length > 0 ? `&with_genres=${topGenres.join('|')}` : '';
        const API_KEY = "181edc5801db6678de6ccb2864149a6a";

        // 2. ดึงข้อมูลจาก TMDB 3 หน้า
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

        // 3. SCORING ENGINE: ให้คะแนนหนังทุกเรื่องตามคะแนนในคลังข้อมูล
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

        scoredItems.sort((a, b) => b.rawScore - a.rawScore);

        const uniqueItems = [];
        const seenIds = new Set();
        for (const item of scoredItems) {
            if (!seenIds.has(item.id) && item.poster_path && item.backdrop_path && item.rawScore > 0) {
                seenIds.add(item.id);
                uniqueItems.push(item);
            }
        }

        const topScore = uniqueItems[0]?.rawScore || 1; 
        const finalResults = uniqueItems.map((item, index) => {
            let percent = 98; 
            if (index > 0) {
                percent = Math.floor((item.rawScore * 98) / topScore);
                if (percent >= 98) percent = 98 - index; 
            }
            return { ...item, matchPercent: percent };
        });

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