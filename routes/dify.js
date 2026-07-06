const express = require('express');

/**
 * สร้าง Router สำหรับเชื่อมต่อ Dify
 * URL ที่ Frontend เรียก: POST /api/dify/chat
 *
 * @param {Function} authenticateToken middleware ตรวจ JWT จาก server.js
 * @returns {import('express').Router}
 */
module.exports = function createDifyRouter(authenticateToken) {
    const router = express.Router();

    router.post('/chat', authenticateToken, async (req, res) => {
        const userId = String(req.user.id);
        const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
        const conversationId =
            req.body.conversationId || req.body.conversation_id || '';

        if (!query) {
            return res.status(400).json({
                message: 'กรุณาระบุข้อความที่ต้องการส่งให้ CINE AI'
            });
        }

        if (!process.env.DIFY_API_KEY) {
            console.error('DIFY_API_KEY is missing');
            return res.status(500).json({
                message: 'Backend ยังไม่ได้ตั้งค่า DIFY_API_KEY'
            });
        }

        const difyApiUrl =
            process.env.DIFY_API_URL ||
            'https://api.dify.ai/v1/chat-messages';

        const payload = {
            inputs: {
                // Dify จะนำตัวแปรนี้ไปใช้เป็น {{user_id}}
                user_id: userId
            },
            query,
            response_mode: 'streaming',
            user: `cinematch_user_${userId}`
        };

        if (conversationId) {
            payload.conversation_id = conversationId;
        }

        try {
            const difyResponse = await fetch(difyApiUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.DIFY_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!difyResponse.ok) {
                const errorText = await difyResponse.text();
                console.error(
                    'Dify API Error:',
                    difyResponse.status,
                    errorText
                );

                return res.status(502).json({
                    message: 'Dify API ประมวลผลไม่สำเร็จ'
                });
            }

            if (!difyResponse.body) {
                return res.status(502).json({
                    message: 'Dify API ไม่ส่งข้อมูลกลับมา'
                });
            }

            const reader = difyResponse.body.getReader();
            const decoder = new TextDecoder('utf-8');

            let buffer = '';
            let fullAnswer = '';
            let finalConversationId = conversationId;
            let streamError = null;

            const processSseLine = (line) => {
                const trimmedLine = line.trim();

                if (!trimmedLine.startsWith('data:')) {
                    return;
                }

                const rawData = trimmedLine.slice(5).trim();

                if (!rawData || rawData === '[DONE]') {
                    return;
                }

                try {
                    const data = JSON.parse(rawData);

                    if (data.conversation_id) {
                        finalConversationId = data.conversation_id;
                    }

                    if (
                        data.event === 'message' ||
                        data.event === 'agent_message'
                    ) {
                        fullAnswer += data.answer || '';
                    }

                    if (data.event === 'error') {
                        streamError = data.message || 'Dify streaming error';
                    }
                } catch (error) {
                    console.error('Cannot parse Dify SSE line:', rawData);
                }
            };

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || '';

                lines.forEach(processSseLine);
            }

            buffer += decoder.decode();

            if (buffer.trim()) {
                processSseLine(buffer);
            }

            if (streamError) {
                console.error('Dify Stream Error:', streamError);
                return res.status(502).json({
                    message: 'Dify ส่งข้อผิดพลาดระหว่างประมวลผล'
                });
            }

            return res.status(200).json({
                answer: fullAnswer.trim(),
                conversationId: finalConversationId || ''
            });
        } catch (error) {
            console.error('Dify Backend Error:', error);

            return res.status(500).json({
                message: 'เกิดข้อผิดพลาดในการเชื่อมต่อ CINE AI'
            });
        }
    });

    return router;
};
