const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
 
const app = express();
app.use(cors());
app.use(express.json());
 
const SECRET_KEY = process.env.JWT_SECRET || 'cinematch_super_secret_key';
 
// เชื่อมต่อฐานข้อมูล Supabase (PostgreSQL)
const { pool } = require('./database');
 
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('เกิดข้อผิดพลาดในการเชื่อมต่อฐานข้อมูล:', err.message);
    } else {
        console.log('เชื่อมต่อฐานข้อมูล PostgreSQL บน Cloud (Supabase) สำเร็จแล้ว!');
    }
});
 
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
 
// ระบบ Auth (สมัครสมาชิก & ล็อกอิน)
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
 
    try {
        const checkUser = await pool.query(
            `SELECT id, name, email FROM users WHERE email = $1 OR name = $2`,
            [email, name]
        );
       
        if (checkUser.rows.length > 0) {
            const existingUser = checkUser.rows[0];
            if (existingUser.name === name) {
                return res.status(400).json({ message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว กรุณาตั้งชื่ออื่น' });
            }
            if (existingUser.email === email) {
                return res.status(400).json({ message: 'อีเมลนี้มีในระบบแล้ว กรุณาเข้าสู่ระบบ' });
            }
        }
 
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
       
        const result = await pool.query(
            `INSERT INTO users (name, email, password, has_completed_quiz) VALUES ($1, $2, $3, 0) RETURNING id`,
            [name, email, hashedPassword]
        );
       
        const userId = result.rows[0].id;
        const token = jwt.sign({ id: userId, name, email }, SECRET_KEY);
       
        res.status(201).json({
            token,
            user: { id: userId, name, email, has_completed_quiz: 0 }
        });
    } catch (err) {
        console.error("Register Error:", err);
        return res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
    }
});
 
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
   
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
 
app.post('/api/preferences', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { genreWeights } = req.body;
 
    if (!genreWeights || Object.keys(genreWeights).length === 0) {
        return res.status(400).json({ message: "ไม่มีข้อมูลคะแนนความชอบส่งมา" });
    }
 
    try {
        for (const [genreName, score] of Object.entries(genreWeights)) {
            await pool.query(
                `INSERT INTO user_preferences (user_id, pref_key, pref_value)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, pref_key)
                 DO UPDATE SET pref_value = EXCLUDED.pref_value`,
                [userId, genreName, score]
            );
        }
        res.status(200).json({ message: 'บันทึกคะแนนความชอบลง Cloud สำเร็จแล้ว' });
    } catch (err) {
        console.error("Save Preferences Error:", err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการบันทึกคะแนนลงคลังข้อมูล' });
    }
});
 
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
 
// ระบบ Like / Dislike ภาพยนตร์
app.post('/api/likes', authenticateToken, async (req, res) => {
    const { movie_id, film_id, action, type, media_type, movie_title, film_title, genres, points, poster_path } = req.body;
    const userId = req.user.id;
   
    // ดักการส่งข้อมูลที่มีตัวอักษรปนมา ให้เหลือแค่ตัวเลข
    const finalMovieId = String(movie_id || film_id).replace(/^(mv-|tv-)/, '');
    const finalAction = action || type;
    const finalTitle = movie_title || film_title || null;
    const finalPoster = poster_path || null;
    const finalGenres = typeof genres === 'object' ? JSON.stringify(genres) : (genres || null);
    const finalPoints = parseInt(points) || 0;
 
    try {
        const checkResult = await pool.query(
            `SELECT id FROM user_likes WHERE user_id = $1 AND movie_id = $2`,
            [userId, finalMovieId]
        );
         
        if (checkResult.rows.length > 0) {
            await pool.query(
                `UPDATE user_likes SET action = $1, media_type = $2, movie_title = $3, poster_path = $4, genres = $5, points = $6 WHERE id = $7`,
                [finalAction, media_type || 'movie', finalTitle, finalPoster, finalGenres, finalPoints, checkResult.rows[0].id]
            );
            return res.status(200).json({ message: "อัปเดตข้อมูลและคะแนนสำเร็จ" });
        } else {
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
 
app.post('/api/likes/batch', authenticateToken, async (req, res) => {
    const { skips } = req.body;
    const userId = req.user.id;
 
    if (!skips || !Array.isArray(skips)) {
        return res.status(400).json({ message: "ข้อมูลที่ส่งมาไม่ถูกต้อง (ต้องเป็น Array)" });
    }
 
    try {
        for (const item of skips) {
            const { movie_id, action, media_type, movie_title, poster_path, genres, points } = item;
           
            const finalMovieId = String(movie_id).replace(/^(mv-|tv-)/, '');
            const finalGenres = typeof genres === 'object' ? JSON.stringify(genres) : (genres || null);
            const finalPoints = parseInt(points) || 0;
 
            const checkResult = await pool.query(
                `SELECT id FROM user_likes WHERE user_id = $1 AND movie_id = $2`,
                [userId, finalMovieId]
            );
 
            if (checkResult.rows.length > 0) {
                await pool.query(
                    `UPDATE user_likes SET action = $1, media_type = $2, movie_title = $3, poster_path = $4, genres = $5, points = $6 WHERE id = $7`,
                    [action, media_type || 'movie', movie_title, poster_path, finalGenres, finalPoints, checkResult.rows[0].id]
                );
            } else {
                await pool.query(
                    `INSERT INTO user_likes (user_id, movie_id, action, media_type, movie_title, poster_path, genres, points) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [userId, finalMovieId, action, media_type || 'movie', movie_title, poster_path, finalGenres, finalPoints]
                );
            }
        }
        return res.status(200).json({ message: "บันทึกข้อมูลแบบกลุ่ม (Batch) สำเร็จ" });
    } catch (err) {
        console.error("Batch Likes Error:", err);
        return res.status(500).json({ message: "เกิดข้อผิดพลาดในการบันทึกฐานข้อมูลแบบกลุ่ม" });
    }
});
 
app.get('/api/likes', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query(
            `SELECT movie_id, action, media_type, movie_title, poster_path, genres, points FROM user_likes WHERE user_id = $1 ORDER BY id DESC`,
            [userId]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Likes Get Error:", err);
        res.status(500).json({ message: 'Database error' });
    }
});
 
app.delete('/api/likes/:movie_id', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const movieId = String(req.params.movie_id).replace(/^(mv-|tv-)/, '');
 
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
 
// ระบบ API แนะนำภาพยนตร์ (Bradley-Terry Model)
 
// API สำหรับบันทึกผลการโหวต This or That
app.post('/api/this-that/vote', authenticateToken, async (req, res) => {
    const { winner_movie_id, loser_movie_id, winner_genre, loser_genre } = req.body;
    const userId = req.user.id;
 
    if (!winner_genre || !loser_genre) {
        return res.status(400).json({ message: "ข้อมูลหมวดหมู่ไม่ครบถ้วน" });
    }
 
    try {
        // เช็คว่าผู้ใช้คนนี้ เคยโหวตหนังคู่นี้ไปแล้วหรือยัง (สลับตำแหน่งผู้ชนะ/แพ้ ก็ถือว่าเป็นคู่เดียวกัน)
        const checkExisting = await pool.query(
            `SELECT id FROM this_that_votes
             WHERE user_id = $1
             AND ((winner_movie_id = $2 AND loser_movie_id = $3) OR (winner_movie_id = $3 AND loser_movie_id = $2))`,
            [userId, winner_movie_id, loser_movie_id]
        );
 
        if (checkExisting.rows.length > 0) {
            // ถ้าเคยโหวตคู่นี้แล้ว ให้อัปเดตข้อมูลเดิม
            await pool.query(
                `UPDATE this_that_votes
                 SET winner_movie_id = $1, loser_movie_id = $2, winner_genre = $3, loser_genre = $4
                 WHERE id = $5`,
                [winner_movie_id, loser_movie_id, winner_genre, loser_genre, checkExisting.rows[0].id]
            );
            return res.status(200).json({ message: 'อัปเดตผลโหวตเดิมสำเร็จ' });
        } else {
            // ถ้ายังไม่เคยโหวตคู่นี้ ค่อยบันทึกแถวใหม่
            await pool.query(
                `INSERT INTO this_that_votes (user_id, winner_movie_id, loser_movie_id, winner_genre, loser_genre)
                 VALUES ($1, $2, $3, $4, $5)`,
                [userId, winner_movie_id, loser_movie_id, winner_genre, loser_genre]
            );
            return res.status(200).json({ message: 'บันทึกผลโหวตสำเร็จ' });
        }
    } catch (err) {
        console.error("Save This/That Vote Error:", err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการบันทึกผลโหวต' });
    }
});
 
// API คำนวณความชอบและแนะนำภาพยนตร์ (Top 10)
app.post('/api/recommendations', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        let userWeights = {};
 
        // ดึงข้อมูล user_preferences ออกมาเป็นฐานคะแนนก่อน
        const prefResult = await pool.query(
            `SELECT pref_key, pref_value FROM user_preferences WHERE user_id = $1`,
            [userId]
        );
        if (prefResult.rows.length > 0) {
            prefResult.rows.forEach(row => {
                userWeights[row.pref_key] = row.pref_value;
            });
        } else if (req.body.genreWeights) {
            userWeights = { ...req.body.genreWeights };
        }
 
        // ดึงข้อมูล Bradley-Terry จากการโหวต This/That มาเป็นคะแนนโบนัส
        const votesResult = await pool.query(
            `SELECT winner_genre, loser_genre, COUNT(*) as wins
             FROM this_that_votes
             WHERE user_id = $1
             GROUP BY winner_genre, loser_genre`,
            [userId]
        );
 
        if (votesResult.rows.length > 0) {
            // คำนวณ Bradley-Terry Model (Zermelo's Algorithm)
            const wins = {};
            const matches = {};
            const genresSet = new Set();
 
            votesResult.rows.forEach(row => {
                const w = row.winner_genre;
                const l = row.loser_genre;
                const count = parseInt(row.wins, 10);
 
                genresSet.add(w);
                genresSet.add(l);
 
                wins[w] = (wins[w] || 0) + count;
                if (!matches[w]) matches[w] = {};
                if (!matches[l]) matches[l] = {};
                matches[w][l] = (matches[w][l] || 0) + count;
                matches[l][w] = (matches[l][w] || 0) + count;
            });
 
            const genres = Array.from(genresSet);
            let p = {};
            genres.forEach(g => p[g] = 1.0);
 
            for (let iter = 0; iter < 10; iter++) {
                const nextP = {};
                let sumNextP = 0;
                for (const i of genres) {
                    let denom = 0;
                    for (const j of genres) {
                        if (i !== j && matches[i] && matches[i][j]) {
                            denom += matches[i][j] / (p[i] + p[j]);
                        }
                    }
                    nextP[i] = denom > 0 ? (wins[i] || 0) / denom : 0;
                    sumNextP += nextP[i];
                }
                for (const i of genres) {
                    p[i] = sumNextP > 0 ? nextP[i] / sumNextP : 1.0 / genres.length;
                }
            }
 
            // เอา Preference ของ Zermelo มาคูณโบนัส แล้วบวกทบเข้าไปในฐานคะแนนเดิม
            genres.forEach(g => {
                const btBonus = p[g] * 15;
                userWeights[g] = (userWeights[g] || 0) + btBonus;
            });
        }
       
        if (Object.keys(userWeights).length === 0) {
            return res.status(200).json([]);
        }
 
        const REVERSE_GENRE_MAP = {
            "แอคชั่นบู้ล้างผลาญ": 28, "ผจญภัย": 12, "แอนิเมชัน": 16, "ตลกขบขัน": 35, "อาชญากรรม": 80,
            "สารคดี": 99, "ดราม่าเข้มข้น": 18, "ครอบครัว": 10751, "แฟนตาซีเวทมนตร์": 14, "ประวัติศาสตร์": 36,
            "สยองขวัญ": 27, "มิวสิคัล": 10402, "ลึกลับซ่อนเงื่อน": 9648, "โรแมนติก": 10749, "ไซไฟอวกาศ": 878,
            "ทีวีมูฟวี่": 10770, "ระทึกขวัญตื่นเต้น": 53, "สงคราม": 10752, "คาวบอยตะวันตก": 37,
            "แอคชั่น": 28, "ตลก": 35, "ดราม่า": 18, "แฟนตาซี": 14, "ลึกลับ": 9648, "ไซไฟ": 878, "ระทึกขวัญ": 53, "คาวบอย": 37
        };
 
        const topGenres = Object.entries(userWeights)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([name]) => REVERSE_GENRE_MAP[name])
            .filter(id => id);
 
        const genreQuery = topGenres.length > 0 ? `&with_genres=${topGenres.join('|')}` : '';
        const API_KEY = process.env.TMDB_API_KEY || "181edc5801db6678de6ccb2864149a6a";
 
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
           
            // ใช้ matchScore ยิ่งหนังมีแนวตรงกับที่ชอบเยอะ ยิ่งจะได้ขึ้นอันดับแรกๆ
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
 
// ระบบ Duo Match (สร้างห้องและจัดการคิว)
const activeRooms = {};
 
app.post('/api/rooms/create', authenticateToken, (req, res) => {
    const { hostName } = req.body;
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
 
    activeRooms[pin] = {
        pin,
        host: { name: hostName, id: req.user.id },
        guest: null,
        status: 'waiting',
        results: null
    };
 
    res.status(200).json({ pin });
});
 
app.post('/api/rooms/join', authenticateToken, (req, res) => {
    const { pin, guestName } = req.body;
 
    if (!activeRooms[pin]) return res.status(404).json({ message: 'ไม่พบรหัสห้องนี้ หรือห้องหมดอายุแล้ว' });
    if (activeRooms[pin].guest) return res.status(400).json({ message: 'ห้องนี้เต็มแล้ว' });
 
    activeRooms[pin].guest = { name: guestName, id: req.user.id };
    activeRooms[pin].status = 'ready';
 
    res.status(200).json({ message: 'เข้าร่วมห้องสำเร็จ', hostName: activeRooms[pin].host.name });
});
 
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
 
app.post('/api/rooms/match/:pin', authenticateToken, async (req, res) => {
    const { pin } = req.params;
    const room = activeRooms[pin];
 
    if (!room || room.status !== 'ready') {
        return res.status(400).json({ message: 'ห้องยังไม่พร้อมสำหรับการประมวลผล' });
    }
 
    try {
        // เรียกใช้ PIVOT Table SQL จาก Supabase (Bayesian Average)
        const result = await pool.query(
            `SELECT * FROM get_duo_match_genres($1, $2)`,
            [room.host.id, room.guest.id]
        );
 
        const topGenres = result.rows;
 
        if (!topGenres || topGenres.length === 0) {
            return res.status(404).json({ message: "ไม่พบความชอบที่ตรงกัน หรือคะแนนไม่ถึงเกณฑ์" });
        }
 
        const REVERSE_GENRE_MAP = {
            "แอคชั่น": 28, "ผจญภัย": 12, "แอนิเมชัน": 16, "ตลก": 35, "อาชญากรรม": 80,
            "สารคดี": 99, "ดราม่า": 18, "ครอบครัว": 10751, "แฟนตาซี": 14, "ประวัติศาสตร์": 36,
            "สยองขวัญ": 27, "มิวสิคัล": 10402, "ลึกลับ": 9648, "โรแมนติก": 10749, "ไซไฟ": 878,
            "ทีวีมูฟวี่": 10770, "ระทึกขวัญ": 53, "สงคราม": 10752, "คาวบอย": 37,
            "แอคชั่นบู้ล้างผลาญ": 28, "ตลกขบขัน": 35, "ดราม่าเข้มข้น": 18, "แฟนตาซีเวทมนตร์": 14,
            "ลึกลับซ่อนเงื่อน": 9648, "ไซไฟอวกาศ": 878, "ระทึกขวัญตื่นเต้น": 53, "คาวบอยตะวันตก": 37
        };
 
        const tmdbGenreIds = topGenres
            .map(g => REVERSE_GENRE_MAP[g.genre])
            .filter(id => id);
 
        const genreQuery = tmdbGenreIds.length > 0 ? `&with_genres=${tmdbGenreIds.join('|')}` : '';
        const API_KEY = process.env.TMDB_API_KEY || "181edc5801db6678de6ccb2864149a6a";
 
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
 
        const uniqueItems = [];
        const seenIds = new Set();
        for (const item of allItems) {
            if (!seenIds.has(item.id) && item.poster_path && item.backdrop_path) {
                seenIds.add(item.id);
                uniqueItems.push(item);
            }
        }
 
        const finalResults = uniqueItems.slice(0, 10).map((item, index) => {
            return { ...item, matchPercent: index === 0 ? 99 : (99 - index) };
        });
 
        room.results = finalResults;
        room.status = 'completed';
 
        res.status(200).json(room.results);
 
    } catch (err) {
        console.error("Duo Match Route Error:", err);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการประมวลผลจับคู่" });
    }
});
 
// AI Search Engine Endpoint
app.post('/api/ai-search', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { query, conversation_id } = req.body;
 
    if (!query || !query.trim()) {
        return res.status(400).json({
            message: 'กรุณาระบุข้อความ',
            ai_message: 'กรุณาพิมพ์ข้อความก่อนนะคะ',
            recommended_movie_ids: [],
            movies: [],
            conversation_id: conversation_id || null
        });
    }
 
    if (!process.env.DIFY_API_KEY) {
        console.error('DIFY_API_KEY is missing');
        return res.status(500).json({
            message: 'ไม่พบ DIFY_API_KEY',
            ai_message: 'ระบบ CINE AI ยังไม่ได้ตั้งค่า API Key ค่ะ',
            recommended_movie_ids: [],
            movies: [],
            conversation_id: conversation_id || null
        });
    }
 
    try {
        const payload = {
            inputs: {
                user_id: String(userId)
            },
            query: query.trim(),
            response_mode: 'streaming',
            user: `cinematch_user_${userId}`
        };
 
        if (conversation_id) {
            payload.conversation_id = conversation_id;
        }
 
        const difyResponse = await fetch(
            'https://api.dify.ai/v1/chat-messages',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.DIFY_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            }
        );
 
        if (!difyResponse.ok) {
            const errorText = await difyResponse.text();
            console.error('Dify API Error:', difyResponse.status, errorText);
            return res.status(502).json({
                message: `Dify API Error ${difyResponse.status}`,
                detail: errorText,
                ai_message: 'ขออภัยค่ะ ระบบ CINE AI เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
                recommended_movie_ids: [],
                movies: [],
                conversation_id: conversation_id || null
            });
        }
 
        if (!difyResponse.body) {
            throw new Error('Dify ไม่ส่ง Response Body กลับมา');
        }
 
        const reader = difyResponse.body.getReader();
        const decoder = new TextDecoder('utf-8');
 
        let buffer = '';
        let fullAnswer = '';
        let finalConversationId = conversation_id || null;
 
        const processEvent = (eventBlock) => {
            const lines = eventBlock.split(/\r?\n/);
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const rawData = line.slice(5).trim();
                if (!rawData || rawData === '[DONE]') continue;
 
                try {
                    const data = JSON.parse(rawData);
                    if (data.conversation_id) {
                        finalConversationId = data.conversation_id;
                    }
                    if (data.event === 'message' || data.event === 'agent_message') {
                        fullAnswer += data.answer || '';
                    }
                    if (data.event === 'error') {
                        console.error('Dify stream error:', data);
                    }
                } catch (error) {
                    console.error('Dify SSE parse error:', error.message, rawData);
                }
            }
        };
 
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const eventBlocks = buffer.split(/\r?\n\r?\n/);
            buffer = eventBlocks.pop() || '';
            eventBlocks.forEach(processEvent);
        }
 
        buffer += decoder.decode();
        if (buffer.trim()) {
            processEvent(buffer);
        }
 
        const rawAnswer = fullAnswer.trim();
 
        if (!rawAnswer) {
            console.error('Dify returned empty answer');
            return res.status(502).json({
                message: 'Dify ไม่ส่งข้อความตอบกลับ',
                ai_message: 'ขออภัยค่ะ CINE AI ยังไม่สามารถสร้างคำตอบได้ กรุณาลองใหม่อีกครั้ง',
                recommended_movie_ids: [],
                movies: [],
                conversation_id: finalConversationId
            });
        }
 
        // แยก JSON ที่อยู่ใน ```json ... ```
        const fencedJsonMatch = rawAnswer.match(/```json\s*([\s\S]*?)\s*```/i);
        const plainArrayMatch = rawAnswer.match(/(\[\s*\{[\s\S]*\}\s*\])/);
        const jsonText = fencedJsonMatch?.[1] || plainArrayMatch?.[1] || '';
 
        let movies = [];

        if (jsonText) {
            try {
                const parsedMovies = JSON.parse(jsonText);
                if (Array.isArray(parsedMovies)) {
                    movies = parsedMovies
                        // ใช้ชื่อเรื่องเป็นข้อมูลหลัก เพราะ AI อาจเดา TMDB ID ผิด
                        .filter(movie => movie?.title_en || movie?.title)
                        .slice(0, 3)
                        .map(movie => {
                            const suppliedId = String(movie.id || '');
                            const mediaType =
                                movie.type === 'tv' ||
                                movie.media_type === 'tv' ||
                                suppliedId.startsWith('tv-')
                                    ? 'tv'
                                    : movie.type === 'movie' ||
                                      movie.media_type === 'movie' ||
                                      suppliedId.startsWith('mv-')
                                        ? 'movie'
                                        : 'multi';

                            const titleEn = String(
                                movie.title_en || movie.title || ''
                            ).trim();

                            return {
                                // ID เป็นข้อมูลประกอบ Frontend จะยืนยันกับ TMDB จากชื่อและปีอีกรอบ
                                id: suppliedId,
                                type: mediaType,
                                media_type: mediaType,
                                title_en: titleEn,
                                title: titleEn,
                                year: String(
                                    movie.year || movie.release_year || ''
                                ).trim(),
                                reason: movie.reason || ''
                            };
                        });
                }
            } catch (error) {
                console.error('Movie JSON Parse Error:', error.message, jsonText);
            }
        }

        const aiMessage = rawAnswer.replace(/```json\s*[\s\S]*?\s*```/i, '').trim();
 
        return res.status(200).json({
            ai_message: aiMessage || (movies.length > 0 ? 'นี่คือภาพยนตร์ที่เลือกมาแนะนำให้คุณค่ะ' : rawAnswer),
            recommended_movie_ids: movies.map(movie => movie.id),
            movies,
            conversation_id: finalConversationId
        });
 
    } catch (error) {
        console.error('AI Search Error:', error);
        return res.status(500).json({
            message: error.message,
            ai_message: 'ขออภัยค่ะ ระบบค้นหาเกิดข้อผิดพลาดชั่วคราว',
            recommended_movie_ids: [],
            movies: [],
            conversation_id: conversation_id || null
        });
    }
});
 
// ค้นหาภาพยนตร์และซีรีส์จากชื่อเรื่อง (TMDB Search)
app.get('/api/search', authenticateToken, async (req, res) => {
    const { query, page = 1 } = req.query;
   
    if (!query) {
        return res.status(400).json({ message: "กรุณาระบุคำค้นหา" });
    }
 
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&include_adult=false&language=th-TH&page=${page}`;
        const options = {
            method: 'GET',
            headers: {
                accept: 'application/json',
                Authorization: `Bearer ${process.env.TMDB_BEARER_TOKEN}`
            }
        };
 
        const response = await fetch(tmdbUrl, options);
        if (!response.ok) throw new Error("TMDB Search Failed");
       
        const data = await response.json();
        const filteredResults = data.results.filter(
            item => item.media_type === 'movie' || item.media_type === 'tv'
        );
 
        res.status(200).json({ ...data, results: filteredResults });
    } catch (err) {
        console.error("Search API Error:", err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการค้นหาข้อมูล' });
    }
});
 
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});