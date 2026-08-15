// server.js - Updated to handle frontend serving correctly
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const path = require('path');
const { body, validationResult, param, query } = require('express-validator');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const stream = require('stream');

const app = express();
app.set('trust proxy', 1);

const FALLBACK_DATA_FILE = path.join(__dirname, 'fallback-data.json');
const RANKING_RESET_FILE = path.join(__dirname, 'ranking-reset.json');

function loadFallbackDataFromFile() {
    try {
        if (fs.existsSync(FALLBACK_DATA_FILE)) {
            const data = fs.readFileSync(FALLBACK_DATA_FILE, 'utf8');
            const parsed = JSON.parse(data);
            return parsed;
        }
    } catch (err) {
        console.error('Failed to load fallback data from file:', err);
    }
    return null;
}

function saveFallbackDataToFile() {
    try {
        if (fallbackData) {
            fs.writeFileSync(FALLBACK_DATA_FILE, JSON.stringify(fallbackData, null, 2));
        }
    } catch (err) {
        console.error('Failed to save fallback data to file:', err);
    }
}

function getLastRankingReset() {
    try {
        if (fs.existsSync(RANKING_RESET_FILE)) {
            const data = fs.readFileSync(RANKING_RESET_FILE, 'utf8');
            const parsed = JSON.parse(data);
            return parsed.lastReset ? new Date(parsed.lastReset) : null;
        }
    } catch (err) {
        console.error('Failed to load ranking reset date:', err);
    }
    return null;
}

function setLastRankingReset() {
    try {
        fs.writeFileSync(RANKING_RESET_FILE, JSON.stringify({ lastReset: new Date().toISOString() }, null, 2));
    } catch (err) {
        console.error('Failed to save ranking reset date:', err);
    }
}

async function checkAndResetRankingsIfNeeded() {
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    let lastReset = null;
    if (isMongoConnected) {
        try {
            const db = mongoose.connection.db;
            const record = await db.collection('ranking_resets').findOne({ _id: 'last_reset' });
            if (record && record.date) lastReset = new Date(record.date);
        } catch (err) {
            console.error('Failed to check ranking reset in MongoDB:', err);
        }
    } else {
        lastReset = getLastRankingReset();
    }

    if (!lastReset || lastReset < twoMonthsAgo) {
        console.log('🔄 Resetting rankings (2 month cycle)...');
        if (isMongoConnected) {
            try {
                const db = mongoose.connection.db;
                await db.collection('feedback').deleteMany({});
                await db.collection('feedbackanswers').deleteMany({});
                await db.collection('ranking_resets').updateOne(
                    { _id: 'last_reset' },
                    { $set: { date: new Date() } },
                    { upsert: true }
                );
            } catch (err) {
                console.error('Failed to reset rankings in MongoDB:', err);
            }
        } else {
            fallbackData.feedback = [];
            fallbackData.feedbackAnswers = [];
            saveFallbackDataToFile();
            setLastRankingReset();
        }
        console.log('✅ Rankings reset complete');
    }
}
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'serveRate-super-secret-key-change-in-production-2026';
const JWT_EXPIRY = '7d';

// =============================================
// MIDDLEWARE
// =============================================
app.use(cors({
    origin: [
        'https://customer-feedback-rev1.onrender.com',
        'https://tablevoice.netlify.app',
        /https:\/\/.*\.netlify\.app/,
        /https:\/\/.*\.pages\.dev/,
        /https:\/\/.*\.cloudflarepages\.com/,
        'http://localhost:3000',
        'http://localhost:10000'
    ],
    credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// =============================================
// MONGODB CONNECTION
// =============================================
let isMongoConnected = false;

function cleanMongoUri(uri) {
    if (!uri) return uri;
    let cleaned = uri.trim();
    const mongoPrefix = cleaned.match(/(mongodb(?:\+srv)?:\/\/.+)/);
    if (mongoPrefix) {
        cleaned = mongoPrefix[1].trim();
    }
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1).trim();
    }
    if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
        cleaned = cleaned.slice(1, -1).trim();
    }
    return cleaned;
}

const rawMongoUri = process.env.MONGODB_URI;
const MONGODB_URI = cleanMongoUri(rawMongoUri);

if (!rawMongoUri) {
    console.error('========================================');
    console.error('❌ CRITICAL: MONGODB_URI is NOT SET');
    console.error('========================================');
    console.error('Set MONGODB_URI in your environment variables.');
    console.error('Example: mongodb+srv://user:pass@cluster.mongodb.net/dbname?retryWrites=true&w=majority');
    console.error('Falling back to in-memory mode...');
} else {
    console.log('========================================');
    console.log('🔌 MONGODB_URI detected:', MONGODB_URI.replace(/\/\/.*@/, '//***@'));
    console.log('========================================');
}

const resolvedMongoUri = MONGODB_URI || 'mongodb://localhost:27017/serverate';

mongoose.connect(resolvedMongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log('✅ MongoDB connected successfully');
    isMongoConnected = true;
    seedDatabase();
})
.catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Please make sure MongoDB is running:');
    console.log('   - Local: mongodb://localhost:27017');
    console.log('   - Or use MongoDB Atlas with MONGODB_URI env variable');
    console.log('💾 Using in-memory fallback mode...');
    isMongoConnected = false;
    initializeFallbackData();
});

// =============================================
// FALLBACK DATA (in-memory)
// =============================================
let fallbackData = null;

function initializeFallbackData() {
    const savedData = loadFallbackDataFromFile();
    if (savedData) {
        fallbackData = savedData;
        console.log('✅ Fallback data loaded from file');
        return;
    }

    fallbackData = {
        managers: [
            { 
                id: 'm1', 
                name: 'Admin', 
                email: 'admin@serverate.com', 
                password_hash: bcrypt.hashSync('admin123', 10),
                created_at: new Date(),
                updated_at: new Date()
            }
        ],
        servers: [],
        questions: [
            { id: 'q1', text: 'How would you rate the food?', category: 'Food', type: 'star', options: [], required: true, active: true, display_order: 1, created_at: new Date(), updated_at: new Date() },
            { id: 'q2', text: 'How was the service?', category: 'Service', type: 'star', options: [], required: true, active: true, display_order: 2, created_at: new Date(), updated_at: new Date() },
            { id: 'q3', text: 'How clean was the restaurant?', category: 'Cleanliness', type: 'star', options: [], required: false, active: true, display_order: 3, created_at: new Date(), updated_at: new Date() },
            { id: 'q4', text: 'How was the waiting time?', category: 'Waiting', type: 'star', options: [], required: false, active: true, display_order: 4, created_at: new Date(), updated_at: new Date() },
            { id: 'q5', text: 'How was the atmosphere?', category: 'Atmosphere', type: 'star', options: [], required: false, active: true, display_order: 5, created_at: new Date(), updated_at: new Date() },
            { id: 'q7', text: 'What did you like most?', category: 'Feedback', type: 'multiple_choice', options: ['Food', 'Service', 'Atmosphere', 'Cleanliness', 'Price', 'Other'], required: false, active: true, display_order: 7, created_at: new Date(), updated_at: new Date() },
            { id: 'q8', text: 'Additional comments', category: 'Feedback', type: 'text', options: [], required: false, active: true, display_order: 8, created_at: new Date(), updated_at: new Date() },
            { id: 'q6', text: 'Will you return?', category: 'Recommendation', type: 'yes_no', options: [], required: true, active: true, display_order: 10, created_at: new Date(), updated_at: new Date() }
        ],
        feedback: [],
        feedbackAnswers: [],
        customers: [],
        settings: {
            restaurant_name: 'My Restaurant',
            description: 'Welcome to our restaurant!',
            include_server_rating: true,
            include_comment: true,
            updated_at: new Date()
        },
        idCounter: 100
    };
    
    console.log('✅ In-memory data initialized (clean slate - no demo data)');
}

// Initialize fallback data immediately to avoid race conditions
initializeFallbackData();

// =============================================
// SEED DATABASE (only if MongoDB is connected)
// =============================================
async function seedDatabase() {
    if (!isMongoConnected) return;
    
    try {
        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);

        // Check if we have any managers
        if (!collectionNames.includes('managers')) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await db.collection('managers').insertOne({
                name: 'Admin',
                email: 'admin@serverate.com',
                password_hash: hashedPassword,
                created_at: new Date(),
                updated_at: new Date()
            });
            console.log('✅ Default manager created: admin@serverate.com / admin123');
        } else {
            const managerCount = await db.collection('managers').countDocuments();
            if (managerCount === 0) {
                const hashedPassword = await bcrypt.hash('admin123', 10);
                await db.collection('managers').insertOne({
                    name: 'Admin',
                    email: 'admin@serverate.com',
                    password_hash: hashedPassword,
                    created_at: new Date(),
                    updated_at: new Date()
                });
                console.log('✅ Default manager created: admin@serverate.com / admin123');
            }
        }

        // Check if we have any questions
        if (!collectionNames.includes('questions') || await db.collection('questions').countDocuments() === 0) {
            const defaultQuestions = [
                { text: 'How would you rate the food?', category: 'Food', type: 'star', options: [], required: true, active: true, display_order: 1 },
                { text: 'How was the service?', category: 'Service', type: 'star', options: [], required: true, active: true, display_order: 2 },
                { text: 'How clean was the restaurant?', category: 'Cleanliness', type: 'star', options: [], required: false, active: true, display_order: 3 },
                { text: 'How was the waiting time?', category: 'Waiting', type: 'star', options: [], required: false, active: true, display_order: 4 },
                { text: 'How was the atmosphere?', category: 'Atmosphere', type: 'star', options: [], required: false, active: true, display_order: 5 },
                { text: 'What did you like most?', category: 'Feedback', type: 'multiple_choice', options: ['Food', 'Service', 'Atmosphere', 'Cleanliness', 'Price', 'Other'], required: false, active: true, display_order: 7 },
                { text: 'Additional comments', category: 'Feedback', type: 'text', options: [], required: false, active: true, display_order: 8 },
                { text: 'Will you return?', category: 'Recommendation', type: 'yes_no', options: [], required: true, active: true, display_order: 10 }
            ];
            for (const q of defaultQuestions) {
                await db.collection('questions').insertOne({
                    ...q,
                    created_at: new Date(),
                    updated_at: new Date()
                });
            }
            console.log('✅ Default questions created');
        } else {
            const q6 = await db.collection('questions').findOne({ id: 'q6' });
            if (q6) {
                const updateFields = { updated_at: new Date() };
                if (q6.text === 'Would you recommend us?') {
                    updateFields.text = 'Will you return?';
                }
                if (q6.display_order !== 10) {
                    updateFields.display_order = 10;
                }
                if (Object.keys(updateFields).length > 1) {
                    await db.collection('questions').updateOne({ id: 'q6' }, { $set: updateFields });
                }
                await db.collection('questions').updateOne({ id: 'q7' }, { $set: { display_order: 7, updated_at: new Date() } });
                await db.collection('questions').updateOne({ id: 'q8' }, { $set: { display_order: 8, updated_at: new Date() } });
                console.log('✅ Question order updated: q6 moved to last');
            }
        }

        // Check if we have settings
        if (!collectionNames.includes('settings') || await db.collection('settings').countDocuments() === 0) {
            await db.collection('settings').insertOne({
                restaurant_name: 'My Restaurant',
                description: 'Welcome to our restaurant!',
                include_server_rating: true,
                include_comment: true,
                updated_at: new Date()
            });
            console.log('✅ Default settings created');
        }

    } catch (err) {
        console.error('Error seeding database:', err);
    }
}

// =============================================
// AUTH MIDDLEWARE
// =============================================


// =============================================
// HELPER FUNCTIONS FOR FALLBACK
// =============================================
function generateId() {
    fallbackData.idCounter++;
    return 'id_' + fallbackData.idCounter;
}

// =============================================
// AUTH ROUTES
// =============================================

// Login
app.post('/api/auth/login', [
    body('email').isEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email, password } = req.body;

    try {
        let user = null;
        let password_hash = null;

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            user = await db.collection('managers').findOne({ email });
            if (user) {
                password_hash = user.password_hash;
            } else {
                const managerCount = await db.collection('managers').countDocuments();
                if (managerCount === 0) {
                    const hashedPassword = await bcrypt.hash('admin123', 10);
                    await db.collection('managers').insertOne({
                        name: 'Admin',
                        email: 'admin@serverate.com',
                        password_hash: hashedPassword,
                        created_at: new Date(),
                        updated_at: new Date()
                    });
                    console.log('✅ Default manager auto-created: admin@serverate.com / admin123');
                    if (email === 'admin@serverate.com') {
                        user = await db.collection('managers').findOne({ email });
                        password_hash = user.password_hash;
                    }
                }
            }
        } else {
            user = fallbackData.managers.find(m => m.email === email);
            if (user) password_hash = user.password_hash;
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const valid = await bcrypt.compare(password, password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id || user._id?.toString(), email: user.email, name: user.name },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRY }
        );

        res.json({
            token,
            user: {
                id: user.id || user._id,
                name: user.name,
                email: user.email,
            },
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Logout
app.post('/api/auth/logout',  (req, res) => {
    res.json({ success: true });
});

// Verify token
app.get('/api/auth/verify', authenticateToken, (req, res) => {
    res.json({ valid: true, user: req.user });
});

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// =============================================
// SERVER ROUTES
// =============================================

// Get all servers
app.get('/api/servers', authenticateToken, async (req, res) => {
    try {
        let servers = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            servers = await db.collection('servers').find().sort({ name: 1 }).toArray();
            
            const serverIds = servers.map(s => s._id);
            const feedbackStats = await db.collection('feedback').aggregate([
                { $match: { server_id: { $in: serverIds }, server_rating: { $ne: null } } },
                { $group: { 
                    _id: '$server_id', 
                    avgRating: { $avg: '$server_rating' }, 
                    reviewCount: { $sum: 1 } 
                }}
            ]).toArray();
            
            const statsMap = {};
            feedbackStats.forEach(f => {
                statsMap[f._id.toString()] = {
                    avgRating: f.avgRating ? Math.round(f.avgRating * 10) / 10 : 0,
                    reviewCount: f.reviewCount || 0
                };
            });
            
            servers = servers.map(s => ({
                id: s._id,
                name: s.name,
                status: s.status,
                avgRating: statsMap[s._id.toString()]?.avgRating || 0,
                reviewCount: statsMap[s._id.toString()]?.reviewCount || 0
            }));
        } else {
            servers = fallbackData.servers.map(s => {
                const serverFeedback = fallbackData.feedback.filter(f => f.server_id === s.id && f.server_rating !== null);
                const avgRating = serverFeedback.length > 0 
                    ? Math.round((serverFeedback.reduce((a, b) => a + (b.server_rating || 0), 0) / serverFeedback.length) * 10) / 10 
                    : 0;
                return {
                    id: s.id,
                    name: s.name,
                    status: s.status,
                    avgRating: avgRating,
                    reviewCount: serverFeedback.length
                };
            });
        }
        res.json(servers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load servers' });
    }
});

// Get active servers (public - for customer kiosk)
app.get('/api/servers/active', async (req, res) => {
    try {
        let servers = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            servers = await db.collection('servers').find({ status: 'active' }).sort({ name: 1 }).toArray();
            
            const serverIds = servers.map(s => s._id);
            const feedbackStats = await db.collection('feedback').aggregate([
                { $match: { server_id: { $in: serverIds }, server_rating: { $ne: null } } },
                { $group: { 
                    _id: '$server_id', 
                    avgRating: { $avg: '$server_rating' }, 
                    reviewCount: { $sum: 1 } 
                }}
            ]).toArray();
            
            const statsMap = {};
            feedbackStats.forEach(f => {
                statsMap[f._id.toString()] = {
                    avgRating: f.avgRating ? Math.round(f.avgRating * 10) / 10 : 0,
                    reviewCount: f.reviewCount || 0
                };
            });
            
            servers = servers.map(s => ({
                id: s._id,
                name: s.name,
                status: s.status,
                avgRating: statsMap[s._id.toString()]?.avgRating || 0,
                reviewCount: statsMap[s._id.toString()]?.reviewCount || 0
            }));
        } else {
            servers = fallbackData.servers.filter(s => s.status === 'active').map(s => {
                const serverFeedback = fallbackData.feedback.filter(f => f.server_id === s.id && f.server_rating !== null);
                const avgRating = serverFeedback.length > 0 
                    ? Math.round((serverFeedback.reduce((a, b) => a + (b.server_rating || 0), 0) / serverFeedback.length) * 10) / 10 
                    : 0;
                return {
                    id: s.id,
                    name: s.name,
                    status: s.status,
                    avgRating: avgRating,
                    reviewCount: serverFeedback.length
                };
            });
        }
        res.json(servers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load servers' });
    }
});

// Get active servers ranked by rating (public)
app.get('/api/servers/ranked', async (req, res) => {
    try {
        let servers = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            servers = await db.collection('servers').find({ status: 'active' }).sort({ name: 1 }).toArray();
            
            const serverIds = servers.map(s => s._id);
            const feedbackStats = await db.collection('feedback').aggregate([
                { $match: { server_id: { $in: serverIds }, server_rating: { $ne: null } } },
                { $group: { 
                    _id: '$server_id', 
                    avgRating: { $avg: '$server_rating' }, 
                    reviewCount: { $sum: 1 },
                    totalStars: { $sum: '$server_rating' }
                }}
            ]).toArray();
            
            const statsMap = {};
            feedbackStats.forEach(f => {
                statsMap[f._id.toString()] = {
                    avgRating: f.avgRating ? Math.round(f.avgRating * 10) / 10 : 0,
                    reviewCount: f.reviewCount || 0,
                    totalStars: f.totalStars || 0
                };
            });
            
            servers = servers.map(s => ({
                id: s._id,
                name: s.name,
                status: s.status,
                avgRating: statsMap[s._id.toString()]?.avgRating || 0,
                reviewCount: statsMap[s._id.toString()]?.reviewCount || 0,
                totalStars: statsMap[s._id.toString()]?.totalStars || 0
            }));
        } else {
            servers = fallbackData.servers.filter(s => s.status === 'active').map(s => {
                const serverFeedback = fallbackData.feedback.filter(f => f.server_id === s.id && f.server_rating !== null);
                const totalStars = serverFeedback.reduce((a, b) => a + (b.server_rating || 0), 0);
                const avgRating = serverFeedback.length > 0 
                    ? Math.round((totalStars / serverFeedback.length) * 10) / 10 
                    : 0;
                return {
                    id: s.id,
                    name: s.name,
                    status: s.status,
                    avgRating: avgRating,
                    reviewCount: serverFeedback.length,
                    totalStars: totalStars
                };
            });
        }
        
        servers.sort((a, b) => {
            const starsDiff = (b.totalStars || 0) - (a.totalStars || 0);
            if (starsDiff !== 0) return starsDiff;
            const avgDiff = (b.avgRating || 0) - (a.avgRating || 0);
            if (avgDiff !== 0) return avgDiff;
            return (b.reviewCount || 0) - (a.reviewCount || 0);
        });
        res.json(servers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load ranked servers' });
    }
});

// Create server
app.post('/api/servers', authenticateToken, [
    body('name').notEmpty().withMessage('Server name required'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { name, status = 'active' } = req.body;

    try {
        let server = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const result = await db.collection('servers').insertOne({
                name,
                status,
                created_at: new Date(),
                updated_at: new Date()
            });
            server = {
                id: result.insertedId,
                name,
                status
            };
        } else {
            server = {
                id: generateId(),
                name,
                status,
                created_at: new Date(),
                updated_at: new Date()
            };
            fallbackData.servers.push(server);
            saveFallbackDataToFile();
        }
        res.status(201).json(server);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create server' });
    }
});

// Update server
app.put('/api/servers/:id', authenticateToken, async (req, res) => {
    const id = req.params.id;
    const { name, status } = req.body;

    try {
        let server = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const updateData = { updated_at: new Date() };
            if (name !== undefined) updateData.name = name;
            if (status !== undefined) updateData.status = status;

            const result = await db.collection('servers').findOneAndUpdate(
                { _id: new mongoose.Types.ObjectId(id) },
                { $set: updateData },
                { returnDocument: 'after' }
            );
            if (!result.value) {
                return res.status(404).json({ error: 'Server not found' });
            }
            server = {
                id: result.value._id,
                name: result.value.name,
                status: result.value.status
            };
        } else {
            const index = fallbackData.servers.findIndex(s => s.id === id);
            if (index === -1) {
                return res.status(404).json({ error: 'Server not found' });
            }
            if (name !== undefined) fallbackData.servers[index].name = name;
            if (status !== undefined) fallbackData.servers[index].status = status;
            fallbackData.servers[index].updated_at = new Date();
            server = fallbackData.servers[index];
            saveFallbackDataToFile();
        }
        res.json(server);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update server' });
    }
});

// Delete server
app.delete('/api/servers/:id', authenticateToken, async (req, res) => {
    const id = req.params.id;

    try {
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const result = await db.collection('servers').deleteOne({ _id: new mongoose.Types.ObjectId(id) });
            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'Server not found' });
            }
        } else {
            const index = fallbackData.servers.findIndex(s => s.id === id);
            if (index === -1) {
                return res.status(404).json({ error: 'Server not found' });
            }
            fallbackData.servers.splice(index, 1);
            saveFallbackDataToFile();
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete server' });
    }
});

// =============================================
// QUESTION ROUTES
// =============================================

// Get all questions
app.get('/api/questions', authenticateToken, async (req, res) => {
    try {
        let questions = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            questions = await db.collection('questions').find().sort({ display_order: 1 }).toArray();
            questions = questions.map(q => ({
                id: q._id,
                text: q.text,
                category: q.category,
                type: q.type,
                options: q.options,
                required: q.required,
                active: q.active,
                display_order: q.display_order,
                created_at: q.created_at,
                updated_at: q.updated_at
            }));
        } else {
            questions = fallbackData.questions;
        }
        res.json(questions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load questions' });
    }
});

// Get active questions (public)
app.get('/api/questions/active', async (req, res) => {
    try {
        let questions = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            questions = await db.collection('questions').find({ active: true }).sort({ display_order: 1 }).toArray();
            questions = questions.map(q => ({
                id: q._id,
                text: q.text,
                category: q.category,
                type: q.type,
                options: q.options,
                required: q.required,
                active: q.active,
                display_order: q.display_order,
                created_at: q.created_at,
                updated_at: q.updated_at
            }));
        } else {
            questions = fallbackData.questions.filter(q => q.active);
        }
        res.json(questions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load questions' });
    }
});

// Create question
app.post('/api/questions', authenticateToken, [
    body('text').notEmpty().withMessage('Question text required'),
    body('type').isIn(['star', 'multiple_choice', 'yes_no', 'text']).withMessage('Invalid question type'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { text, category, type, options = [], required = true, active = true, displayOrder = 0 } = req.body;

    try {
        let question = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const result = await db.collection('questions').insertOne({
                text,
                category: category || 'General',
                type,
                options: type === 'multiple_choice' ? options : [],
                required,
                active,
                display_order: displayOrder || 0,
                created_at: new Date(),
                updated_at: new Date()
            });
            question = {
                id: result.insertedId,
                text,
                category: category || 'General',
                type,
                options: type === 'multiple_choice' ? options : [],
                required,
                active,
                display_order: displayOrder || 0
            };
        } else {
            question = {
                id: generateId(),
                text,
                category: category || 'General',
                type,
                options: type === 'multiple_choice' ? options : [],
                required,
                active,
                display_order: displayOrder || 0,
                created_at: new Date(),
                updated_at: new Date()
            };
            fallbackData.questions.push(question);
            saveFallbackDataToFile();
        }
        res.status(201).json(question);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create question' });
    }
});

// Update question
app.put('/api/questions/:id', authenticateToken, async (req, res) => {
    const id = req.params.id;
    const { text, category, type, options, required, active, displayOrder } = req.body;

    try {
        let question = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const updateData = { updated_at: new Date() };
            if (text !== undefined) updateData.text = text;
            if (category !== undefined) updateData.category = category || 'General';
            if (type !== undefined) updateData.type = type;
            if (options !== undefined) updateData.options = options || [];
            if (required !== undefined) updateData.required = required;
            if (active !== undefined) updateData.active = active;
            if (displayOrder !== undefined) updateData.display_order = displayOrder || 0;

            const result = await db.collection('questions').findOneAndUpdate(
                { _id: new mongoose.Types.ObjectId(id) },
                { $set: updateData },
                { returnDocument: 'after' }
            );
            if (!result.value) {
                return res.status(404).json({ error: 'Question not found' });
            }
            question = {
                id: result.value._id,
                text: result.value.text,
                category: result.value.category,
                type: result.value.type,
                options: result.value.options,
                required: result.value.required,
                active: result.value.active,
                display_order: result.value.display_order,
                created_at: result.value.created_at,
                updated_at: result.value.updated_at
            };
        } else {
            const index = fallbackData.questions.findIndex(q => q.id === id);
            if (index === -1) {
                return res.status(404).json({ error: 'Question not found' });
            }
            if (text !== undefined) fallbackData.questions[index].text = text;
            if (category !== undefined) fallbackData.questions[index].category = category || 'General';
            if (type !== undefined) fallbackData.questions[index].type = type;
            if (options !== undefined) fallbackData.questions[index].options = options || [];
            if (required !== undefined) fallbackData.questions[index].required = required;
            if (active !== undefined) fallbackData.questions[index].active = active;
            if (displayOrder !== undefined) fallbackData.questions[index].display_order = displayOrder || 0;
            fallbackData.questions[index].updated_at = new Date();
            question = fallbackData.questions[index];
            saveFallbackDataToFile();
        }
        res.json(question);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update question' });
    }
});

// Delete question
app.delete('/api/questions/:id', authenticateToken, async (req, res) => {
    const id = req.params.id;

    try {
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const answerCount = await db.collection('feedbackanswers').countDocuments({ question_id: id });
            if (answerCount > 0) {
                await db.collection('questions').updateOne(
                    { _id: new mongoose.Types.ObjectId(id) },
                    { $set: { active: false, updated_at: new Date() } }
                );
                return res.json({ success: true, message: 'Question deactivated due to existing answers' });
            }
            const result = await db.collection('questions').deleteOne({ _id: new mongoose.Types.ObjectId(id) });
            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'Question not found' });
            }
        } else {
            const answerCount = fallbackData.feedbackAnswers.filter(fa => fa.question_id === id).length;
            if (answerCount > 0) {
                const question = fallbackData.questions.find(q => q.id === id);
                if (question) {
                    question.active = false;
                    question.updated_at = new Date();
                }
                return res.json({ success: true, message: 'Question deactivated due to existing answers' });
            }
            const index = fallbackData.questions.findIndex(q => q.id === id);
            if (index === -1) {
                return res.status(404).json({ error: 'Question not found' });
            }
            fallbackData.questions.splice(index, 1);
            saveFallbackDataToFile();
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete question' });
    }
});

// =============================================
// FEEDBACK ROUTES
// =============================================

// Submit feedback (public)
app.post('/api/feedback', [
    body('serverId').notEmpty().withMessage('Server ID required'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { serverId, answers = [], serverRating, comment, deviceInfo = {}, customerName, customerEmail, customerPhone } = req.body;

    try {
        // Verify server exists and is active
        let server = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            server = await db.collection('servers').findOne({ _id: new mongoose.Types.ObjectId(serverId), status: 'active' });
        } else {
            server = fallbackData.servers.find(s => s.id === serverId && s.status === 'active');
        }

        if (!server) {
            return res.status(400).json({ error: 'Invalid or inactive server' });
        }

        // Calculate overall rating from answers
        let overallRating = null;
        let questionIds = answers.map(a => a.questionId);
        let questions = [];

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            questions = await db.collection('questions').find({ _id: { $in: questionIds.map(id => new mongoose.Types.ObjectId(id)) } }).toArray();
        } else {
            questions = fallbackData.questions.filter(q => questionIds.includes(q.id));
        }

        const starQuestions = questions.filter(q => q.type === 'star');
        for (const answer of answers) {
            if (starQuestions.some(q => (q._id || q.id).toString() === answer.questionId)) {
                const val = parseFloat(answer.answer);
                if (!isNaN(val) && val >= 1 && val <= 5) {
                    overallRating = val;
                    break;
                }
            }
        }

        if (overallRating === null && serverRating != null) {
            overallRating = parseFloat(serverRating);
        }

        let feedbackId = null;

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const result = await db.collection('feedback').insertOne({
                server_id: new mongoose.Types.ObjectId(serverId),
                overall_rating: overallRating,
                server_rating: serverRating || null,
                comment: comment || null,
                device_info: deviceInfo,
                customer_name: customerName || null,
                customer_email: customerEmail || null,
                customer_phone: customerPhone || null,
                created_at: new Date()
            });
            feedbackId = result.insertedId;

            // Create answers
            for (const answer of answers) {
                if (answer.answer !== null && answer.answer !== undefined && answer.answer !== '') {
                    await db.collection('feedbackanswers').insertOne({
                        feedback_id: feedbackId,
                        question_id: new mongoose.Types.ObjectId(answer.questionId),
                        answer: String(answer.answer),
                        created_at: new Date()
                    });
                }
            }
        } else {
            feedbackId = generateId();
            fallbackData.feedback.push({
                id: feedbackId,
                server_id: serverId,
                overall_rating: overallRating,
                server_rating: serverRating || null,
                comment: comment || null,
                device_info: deviceInfo,
                customer_name: customerName || null,
                customer_email: customerEmail || null,
                customer_phone: customerPhone || null,
                created_at: new Date()
            });

            for (const answer of answers) {
                if (answer.answer !== null && answer.answer !== undefined && answer.answer !== '') {
                    fallbackData.feedbackAnswers.push({
                        id: generateId(),
                        feedback_id: feedbackId,
                        question_id: answer.questionId,
                        answer: String(answer.answer),
                        created_at: new Date()
                    });
                }
            }
            saveFallbackDataToFile();
        }

        res.status(201).json({
            success: true,
            feedbackId: feedbackId,
            message: 'Feedback submitted successfully',
        });

    } catch (err) {
        console.error('Feedback submission error:', err);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

// Get feedback (authenticated)
app.get('/api/feedback', authenticateToken, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const serverId = req.query.serverId;
    const rating = req.query.rating ? parseInt(req.query.rating) : null;

    try {
        let items = [];
        let total = 0;

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            let filter = {};
            if (serverId) filter.server_id = new mongoose.Types.ObjectId(serverId);
            if (rating) filter.overall_rating = rating;

            if (search) {
                filter.comment = { $regex: search, $options: 'i' };
            }

            const feedbacks = await db.collection('feedback')
                .find(filter)
                .sort({ created_at: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            total = await db.collection('feedback').countDocuments(filter);

            const serverIds = feedbacks.map(f => f.server_id);
            const servers = await db.collection('servers')
                .find({ _id: { $in: serverIds } })
                .toArray();
            const serverMap = {};
            servers.forEach(s => { serverMap[s._id.toString()] = s.name; });

            const feedbackIds = feedbacks.map(f => f._id);
            const feedbackAnswers = await db.collection('feedbackanswers')
                .find({ feedback_id: { $in: feedbackIds } })
                .toArray();

            const questionIds = [...new Set(feedbackAnswers.map(fa => fa.question_id))];
            const questions = await db.collection('questions')
                .find({ _id: { $in: questionIds } })
                .toArray();
            const questionMap = {};
            questions.forEach(q => { questionMap[q._id.toString()] = q; });

            const yesNoQuestions = Object.values(questionMap).filter(q => q.type === 'yes_no').sort((a, b) => (b.display_order || 0) - (a.display_order || 0));
            const q6Question = yesNoQuestions.length > 0 ? yesNoQuestions[0] : Object.values(questionMap).find(q => q.id === 'q6');
            const q6ObjectId = q6Question ? q6Question._id.toString() : null;

            const answersByFeedback = {};
            feedbackAnswers.forEach(fa => {
                const fid = fa.feedback_id.toString();
                if (!answersByFeedback[fid]) answersByFeedback[fid] = [];
                const q = questionMap[fa.question_id.toString()];
                if (q && q.type === 'text') {
                    answersByFeedback[fid].push({
                        questionId: fa.question_id,
                        questionText: q.text,
                        answer: fa.answer
                    });
                }
            });

            items = feedbacks.map(f => ({
                id: f._id,
                serverId: f.server_id,
                serverName: serverMap[f.server_id.toString()] || 'Unknown',
                overallRating: f.overall_rating,
                serverRating: f.server_rating,
                comment: f.comment,
                customerName: f.customer_name,
                customerEmail: f.customer_email,
                customerPhone: f.customer_phone,
                recommendation: q6ObjectId ? (feedbackAnswers.find(fa => fa.feedback_id.toString() === f._id.toString() && fa.question_id.toString() === q6ObjectId)?.answer || null) : null,
                createdAt: f.created_at,
                textAnswers: answersByFeedback[f._id.toString()] || []
            }));
        } else {
            let feedbacks = [...fallbackData.feedback];
            
            if (serverId) feedbacks = feedbacks.filter(f => f.server_id === serverId);
            if (rating) feedbacks = feedbacks.filter(f => f.overall_rating === rating);
            if (search) {
                feedbacks = feedbacks.filter(f => 
                    f.comment && f.comment.toLowerCase().includes(search.toLowerCase())
                );
            }

            total = feedbacks.length;
            feedbacks = feedbacks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            const paginated = feedbacks.slice(skip, skip + limit);

            const serverMap = {};
            fallbackData.servers.forEach(s => { serverMap[s.id] = s.name; });

            const questionMap = {};
            fallbackData.questions.forEach(q => { questionMap[q.id] = q; });

            items = paginated.map(f => {
                const feedbackAnswers = fallbackData.feedbackAnswers.filter(fa => fa.feedback_id === f.id);
                const textAnswers = feedbackAnswers
                    .map(fa => {
                        const q = questionMap[fa.question_id];
                        return q && q.type === 'text' ? {
                            questionId: fa.question_id,
                            questionText: q.text,
                            answer: fa.answer
                        } : null;
                    })
                    .filter(Boolean);
                const yesNoQuestions = fallbackData.questions.filter(q => q.type === 'yes_no').sort((a, b) => (b.display_order || 0) - (a.display_order || 0));
                const lastYesNoId = yesNoQuestions.length > 0 ? yesNoQuestions[0].id : 'q6';
                const recommendationAnswer = feedbackAnswers.find(fa => fa.question_id === lastYesNoId)?.answer || null;
                return {
                    id: f.id,
                    serverId: f.server_id,
                    serverName: serverMap[f.server_id] || 'Unknown',
                    overallRating: f.overall_rating,
                    serverRating: f.server_rating,
                    comment: f.comment,
                    customerName: f.customer_name,
                    customerEmail: f.customer_email,
                    customerPhone: f.customer_phone,
                    recommendation: recommendationAnswer,
                    createdAt: f.created_at,
                    textAnswers: textAnswers
                };
            });
        }

        res.json({
            items,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load feedback' });
    }
});

// Get single feedback
app.get('/api/feedback/:id', authenticateToken, async (req, res) => {
    const id = req.params.id;

    try {
        let feedback = null;
        let answers = [];

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            feedback = await db.collection('feedback').findOne({ _id: new mongoose.Types.ObjectId(id) });
            if (!feedback) {
                return res.status(404).json({ error: 'Feedback not found' });
            }

            const server = await db.collection('servers').findOne({ _id: feedback.server_id });
            const feedbackAnswers = await db.collection('feedbackanswers')
                .find({ feedback_id: new mongoose.Types.ObjectId(id) })
                .toArray();
            
            const questionIds = feedbackAnswers.map(fa => fa.question_id);
            const questions = await db.collection('questions')
                .find({ _id: { $in: questionIds } })
                .toArray();
            const questionMap = {};
            questions.forEach(q => { questionMap[q._id.toString()] = q; });

            answers = feedbackAnswers.map(fa => ({
                questionId: fa.question_id,
                questionText: questionMap[fa.question_id.toString()]?.text || 'Unknown',
                category: questionMap[fa.question_id.toString()]?.category || 'General',
                answer: fa.answer
            }));

            res.json({
                id: feedback._id,
                serverId: feedback.server_id,
                serverName: server?.name || 'Unknown',
                overallRating: feedback.overall_rating,
                serverRating: feedback.server_rating,
                comment: feedback.comment,
                customerName: feedback.customer_name,
                customerEmail: feedback.customer_email,
                customerPhone: feedback.customer_phone,
                createdAt: feedback.created_at,
                answers
            });
        } else {
            feedback = fallbackData.feedback.find(f => f.id === id);
            if (!feedback) {
                return res.status(404).json({ error: 'Feedback not found' });
            }

            const server = fallbackData.servers.find(s => s.id === feedback.server_id);
            const feedbackAnswers = fallbackData.feedbackAnswers.filter(fa => fa.feedback_id === id);
            const questionMap = {};
            fallbackData.questions.forEach(q => { questionMap[q.id] = q; });

            answers = feedbackAnswers.map(fa => ({
                questionId: fa.question_id,
                questionText: questionMap[fa.question_id]?.text || 'Unknown',
                category: questionMap[fa.question_id]?.category || 'General',
                answer: fa.answer
            }));

            res.json({
                id: feedback.id,
                serverId: feedback.server_id,
                serverName: server?.name || 'Unknown',
                overallRating: feedback.overall_rating,
                serverRating: feedback.server_rating,
                comment: feedback.comment,
                customerName: feedback.customer_name,
                customerEmail: feedback.customer_email,
                customerPhone: feedback.customer_phone,
                createdAt: feedback.created_at,
                answers
            });
        }

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load feedback' });
    }
});

// =============================================
// CUSTOMER ROUTES
// =============================================

// Submit customer contact info (public)
app.post('/api/customers', [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone').notEmpty().withMessage('Phone number is required'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { name, email, phone } = req.body;

    try {
        const customer = {
            id: 'cust_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            name: name.trim(),
            email: email.trim().toLowerCase(),
            phone: phone.trim(),
            created_at: new Date()
        };

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const result = await db.collection('customers').insertOne(customer);
            customer.id = result.insertedId;
        } else {
            fallbackData.customers.push(customer);
            saveFallbackDataToFile();
        }

        res.status(201).json({ success: true, customer });
    } catch (err) {
        console.error('Customer submission error:', err);
        res.status(500).json({ error: 'Failed to save customer info' });
    }
});

// Get all customers (authenticated)
app.get('/api/customers', authenticateToken, async (req, res) => {
    try {
        let customers = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            customers = await db.collection('customers').find().sort({ created_at: -1 }).toArray();
            customers = customers.map(c => ({
                id: c._id,
                name: c.name,
                email: c.email,
                phone: c.phone,
                createdAt: c.created_at
            }));
        } else {
            customers = [...fallbackData.customers].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }
        res.json(customers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load customers' });
    }
});

// Download customers as PDF (authenticated) - 20 customers per page
app.get('/api/customers/download-pdf', authenticateToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const skip = (page - 1) * limit;

        let customers = [];
        let total = 0;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            total = await db.collection('customers').countDocuments();
            customers = await db.collection('customers').find().sort({ created_at: -1 }).skip(skip).limit(limit).toArray();
        } else {
            const sorted = [...fallbackData.customers].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            total = sorted.length;
            customers = sorted.slice(skip, skip + limit);
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=customers.pdf');

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => res.send(Buffer.concat(chunks)));
        doc.on('error', (err) => {
            console.error('PDF generation error:', err);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
        });

        doc.fontSize(20).text('ServeRate - Customer List', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(10).text(`Page ${page} | Generated on: ${new Date().toLocaleString()} | Showing ${skip + 1}-${Math.min(skip + limit, total)} of ${total}`, { align: 'center' });
        doc.moveDown(1);

        doc.fontSize(14).text('Customers', { underline: true });
        doc.moveDown(0.3);

        const startX = 50;
        const colWidths = [150, 200, 120, 80];
        const rowHeight = 18;
        let currentY = doc.y;

        doc.fontSize(10).font('Helvetica-Bold');
        doc.text('Name', startX, currentY, { width: colWidths[0] });
        doc.text('Email', startX + colWidths[0], currentY, { width: colWidths[1] });
        doc.text('Phone', startX + colWidths[0] + colWidths[1], currentY, { width: colWidths[2] });
        doc.text('Date Added', startX + colWidths[0] + colWidths[1] + colWidths[2], currentY, { width: colWidths[3] });
        doc.font('Helvetica');
        currentY += 20;

        customers.forEach((c, idx) => {
            if (idx > 0 && idx % 20 === 0) {
                doc.addPage();
                currentY = 50;
                doc.fontSize(10).font('Helvetica-Bold');
                doc.text('Name', startX, currentY, { width: colWidths[0] });
                doc.text('Email', startX + colWidths[0], currentY, { width: colWidths[1] });
                doc.text('Phone', startX + colWidths[0] + colWidths[1], currentY, { width: colWidths[2] });
                doc.text('Date Added', startX + colWidths[0] + colWidths[1] + colWidths[2], currentY, { width: colWidths[3] });
                doc.font('Helvetica');
                currentY += 20;
            }

            const name = c.name || '';
            const email = c.email || '';
            const phone = c.phone || '';
            const date = new Date(c.created_at).toLocaleDateString();

            doc.text(name, startX, currentY, { width: colWidths[0] });
            doc.text(email, startX + colWidths[0], currentY, { width: colWidths[1] });
            doc.text(phone, startX + colWidths[0] + colWidths[1], currentY, { width: colWidths[2] });
            doc.text(date, startX + colWidths[0] + colWidths[1] + colWidths[2], currentY, { width: colWidths[3] });

            currentY += rowHeight;
        });

        doc.end();
    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to download customers PDF' });
    }
});

// =============================================
// ANALYTICS ROUTES
// =============================================

// Dashboard analytics
app.get('/api/analytics/dashboard', authenticateToken, async (req, res) => {
    try {
        let data = {};

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            
            const [
                totalFeedback,
                totalRatings,
                serverRatings,
                todayFeedback,
                avgRestaurant,
                avgServer,
                positive,
                negative,
                total
            ] = await Promise.all([
                db.collection('feedback').countDocuments(),
                db.collection('feedback').countDocuments({ overall_rating: { $ne: null } }),
                db.collection('feedback').countDocuments({ server_rating: { $ne: null } }),
                db.collection('feedback').countDocuments({ 
                    created_at: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } 
                }),
                db.collection('feedback').aggregate([
                    { $match: { overall_rating: { $ne: null } } },
                    { $group: { _id: null, avg: { $avg: '$overall_rating' } } }
                ]).toArray(),
                db.collection('feedback').aggregate([
                    { $match: { server_rating: { $ne: null } } },
                    { $group: { _id: null, avg: { $avg: '$server_rating' } } }
                ]).toArray(),
                db.collection('feedback').countDocuments({ overall_rating: { $gte: 4 } }),
                db.collection('feedback').countDocuments({ overall_rating: { $lte: 2 } }),
                db.collection('feedback').countDocuments({ overall_rating: { $ne: null } })
            ]);

            const avgRestaurantRating = avgRestaurant.length > 0 ? avgRestaurant[0].avg : 0;
            const avgServerRating = avgServer.length > 0 ? avgServer[0].avg : 0;
            const totalWithRating = total || 1;

            // Get trend data
            const trend = [];
            for (let i = 6; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                const startOfDay = new Date(date.setHours(0, 0, 0, 0));
                const endOfDay = new Date(date.setHours(23, 59, 59, 999));
                
                const result = await db.collection('feedback').aggregate([
                    {
                        $match: {
                            created_at: { $gte: startOfDay, $lte: endOfDay },
                            overall_rating: { $ne: null }
                        }
                    },
                    {
                        $group: {
                            _id: null,
                            avg: { $avg: '$overall_rating' },
                            count: { $sum: 1 }
                        }
                    }
                ]).toArray();
                
                trend.push({
                    label: startOfDay.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    value: result.length > 0 ? result[0].avg : 0,
                    count: result.length > 0 ? result[0].count : 0
                });
            }

            // Get distribution
            const distribution = [];
            for (let r = 5; r >= 1; r--) {
                const count = await db.collection('feedback').countDocuments({ overall_rating: r });
                distribution.push({
                    label: `${r}★`,
                    count: count
                });
            }

            // Get recent feedback
            const recentFeedback = await db.collection('feedback')
                .find()
                .sort({ created_at: -1 })
                .limit(10)
                .toArray();

            const serverIds = recentFeedback.map(f => f.server_id);
            const servers = await db.collection('servers')
                .find({ _id: { $in: serverIds } })
                .toArray();
            const serverMap = {};
            servers.forEach(s => { serverMap[s._id.toString()] = s.name; });

            const recent = recentFeedback.map(f => ({
                id: f._id,
                serverName: serverMap[f.server_id.toString()] || 'Unknown',
                overallRating: f.overall_rating,
                serverRating: f.server_rating,
                comment: f.comment,
                createdAt: f.created_at
            }));

            data = {
                totalFeedback,
                avgRestaurantRating,
                avgServerRating,
                todayFeedback: todayFeedback,
                restaurantRatings: totalRatings,
                serverRatings: serverRatings,
                positivePercentage: Math.round((positive / totalWithRating) * 100),
                negativePercentage: Math.round((negative / totalWithRating) * 100),
                trend,
                distribution,
                recentFeedback: recent
            };
        } else {
            // Fallback data
            const fb = fallbackData.feedback;
            const total = fb.length;
            const totalWithRating = fb.filter(f => f.overall_rating !== null).length || 1;
            const avgRest = totalWithRating > 0 ? fb.reduce((a, b) => a + (b.overall_rating || 0), 0) / totalWithRating : 0;
            const avgServ = fb.filter(f => f.server_rating !== null).length > 0 ? 
                fb.reduce((a, b) => a + (b.server_rating || 0), 0) / fb.filter(f => f.server_rating !== null).length : 0;
            const today = fb.filter(f => new Date(f.created_at).toDateString() === new Date().toDateString()).length;
            const positive = fb.filter(f => f.overall_rating >= 4).length;
            const negative = fb.filter(f => f.overall_rating <= 2).length;

            // Trend data
            const trend = [];
            for (let i = 6; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                const startOfDay = new Date(date.setHours(0, 0, 0, 0));
                const dayFeedbacks = fb.filter(f => {
                    const fDate = new Date(f.created_at);
                    return fDate >= startOfDay && fDate < new Date(startOfDay.getTime() + 86400000);
                });
                const avg = dayFeedbacks.filter(f => f.overall_rating !== null).length > 0 ?
                    dayFeedbacks.reduce((a, b) => a + (b.overall_rating || 0), 0) / dayFeedbacks.filter(f => f.overall_rating !== null).length : 0;
                trend.push({
                    label: startOfDay.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    value: avg,
                    count: dayFeedbacks.length
                });
            }

            // Distribution
            const distribution = [];
            for (let r = 5; r >= 1; r--) {
                distribution.push({
                    label: `${r}★`,
                    count: fb.filter(f => f.overall_rating === r).length
                });
            }

            // Recent feedback
            const recent = fb.slice(-10).reverse().map(f => ({
                id: f.id,
                serverName: fallbackData.servers.find(s => s.id === f.server_id)?.name || 'Unknown',
                overallRating: f.overall_rating,
                serverRating: f.server_rating,
                comment: f.comment,
                createdAt: f.created_at
            }));

            data = {
                totalFeedback: total,
                avgRestaurantRating: avgRest,
                avgServerRating: avgServ,
                todayFeedback: today,
                restaurantRatings: totalWithRating,
                serverRatings: fb.filter(f => f.server_rating !== null).length,
                positivePercentage: Math.round((positive / totalWithRating) * 100),
                negativePercentage: Math.round((negative / totalWithRating) * 100),
                trend,
                distribution,
                recentFeedback: recent
            };
        }

        res.json(data);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load dashboard data' });
    }
});

// Reports analytics
app.get('/api/analytics/reports', authenticateToken, async (req, res) => {
    try {
        let data = {};

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            
            const totalFeedback = await db.collection('feedback').countDocuments();
            const avgRestaurant = await db.collection('feedback').aggregate([
                { $match: { overall_rating: { $ne: null } } },
                { $group: { _id: null, avg: { $avg: '$overall_rating' } } }
            ]).toArray();
            const avgServer = await db.collection('feedback').aggregate([
                { $match: { server_rating: { $ne: null } } },
                { $group: { _id: null, avg: { $avg: '$server_rating' } } }
            ]).toArray();

            // Server rankings
            const serverRankings = await db.collection('feedback').aggregate([
                { $match: { server_rating: { $ne: null } } },
                {
                    $group: {
                        _id: '$server_id',
                        count: { $sum: 1 },
                        totalStars: { $sum: '$server_rating' },
                        avgRating: { $avg: '$server_rating' }
                    }
                },
                {
                    $lookup: {
                        from: 'servers',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'server'
                    }
                },
                { $unwind: '$server' },
                { $match: { 'server.status': 'active' } },
                { $sort: { totalStars: -1, avgRating: -1, count: -1 } }
            ]).toArray();

            // Category ratings
            const categoryRatings = await db.collection('feedbackanswers').aggregate([
                {
                    $lookup: {
                        from: 'questions',
                        localField: 'question_id',
                        foreignField: '_id',
                        as: 'question'
                    }
                },
                { $unwind: '$question' },
                {
                    $match: {
                        'question.type': 'star'
                    }
                },
                {
                    $group: {
                        _id: '$question.category',
                        avgRating: { $avg: { $toDouble: '$answer' } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { avgRating: -1 } }
            ]).toArray();

            const yesNoQuestions = await db.collection('questions').find({ type: 'yes_no' }).sort({ display_order: -1 }).limit(1).toArray();
            const q6Question = yesNoQuestions.length > 0 ? yesNoQuestions[0] : await db.collection('questions').findOne({ id: 'q6' });
            const q6Answers = q6Question ? await db.collection('feedbackanswers').find({ question_id: q6Question._id }).toArray() : [];
            const willReturn = q6Answers.filter(a => a.answer === 'Yes').length;
            const willNotReturn = q6Answers.filter(a => a.answer === 'No').length;

            data = {
                totalFeedback,
                avgRestaurantRating: avgRestaurant.length > 0 ? avgRestaurant[0].avg : 0,
                avgServerRating: avgServer.length > 0 ? avgServer[0].avg : 0,
                bestServer: serverRankings.length > 0 ? {
                    name: serverRankings[0].server.name,
                    avgRating: serverRankings[0].avgRating || 0,
                    count: serverRankings[0].count
                } : null,
                worstServer: serverRankings.length > 0 ? {
                    name: serverRankings[serverRankings.length - 1].server.name,
                    avgRating: serverRankings[serverRankings.length - 1].avgRating || 0,
                    count: serverRankings[serverRankings.length - 1].count
                } : null,
                serverRankings: serverRankings.map(s => ({
                    id: s._id,
                    name: s.server.name,
                    count: s.count,
                    totalStars: s.totalStars || 0,
                    avgRating: s.avgRating || 0
                })),
                categoryRatings: categoryRatings.map(c => ({
                    category: c._id || 'Uncategorized',
                    avgRating: c.avgRating || 0,
                    count: c.count
                })),
                willReturn,
                willNotReturn
            };
        } else {
            const fb = fallbackData.feedback;
            const total = fb.length;
            const avgRest = fb.filter(f => f.overall_rating !== null).length > 0 ?
                fb.reduce((a, b) => a + (b.overall_rating || 0), 0) / fb.filter(f => f.overall_rating !== null).length : 0;
            const avgServ = fb.filter(f => f.server_rating !== null).length > 0 ?
                fb.reduce((a, b) => a + (b.server_rating || 0), 0) / fb.filter(f => f.server_rating !== null).length : 0;

            // Server rankings
            const serverRankings = fallbackData.servers
                .filter(s => s.status === 'active')
                .map(s => {
                    const reviews = fb.filter(f => f.server_id === s.id && f.server_rating !== null);
                    const totalStars = reviews.reduce((a, b) => a + (b.server_rating || 0), 0);
                    const avg = reviews.length > 0 ? totalStars / reviews.length : 0;
                    return { 
                        id: s.id, 
                        name: s.name, 
                        count: reviews.length, 
                        totalStars: totalStars,
                        avgRating: avg 
                    };
                })
                .filter(s => s.count > 0)
                .sort((a, b) => {
                    const starsDiff = (b.totalStars || 0) - (a.totalStars || 0);
                    if (starsDiff !== 0) return starsDiff;
                    const avgDiff = (b.avgRating || 0) - (a.avgRating || 0);
                    if (avgDiff !== 0) return avgDiff;
                    return (b.count || 0) - (a.count || 0);
                });

            // Category ratings
            const categoryRatings = [];
            const categories = {};
            fallbackData.feedbackAnswers.forEach(fa => {
                const question = fallbackData.questions.find(q => q.id === fa.question_id);
                if (question && question.type === 'star') {
                    if (!categories[question.category]) categories[question.category] = [];
                    categories[question.category].push(parseFloat(fa.answer));
                }
            });
            for (const [category, ratings] of Object.entries(categories)) {
                const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
                categoryRatings.push({ category, avgRating: avg, count: ratings.length });
            }
            categoryRatings.sort((a, b) => b.avgRating - a.avgRating);

            const yesNoQuestions = fallbackData.questions.filter(q => q.type === 'yes_no').sort((a, b) => (b.display_order || 0) - (a.display_order || 0));
            const lastYesNoId = yesNoQuestions.length > 0 ? yesNoQuestions[0].id : 'q6';
            const q6Answers = fallbackData.feedbackAnswers.filter(fa => fa.question_id === lastYesNoId);
            const willReturn = q6Answers.filter(a => a.answer === 'Yes').length;
            const willNotReturn = q6Answers.filter(a => a.answer === 'No').length;

            data = {
                totalFeedback: total,
                avgRestaurantRating: avgRest,
                avgServerRating: avgServ,
                bestServer: serverRankings.length > 0 ? {
                    name: serverRankings[0].name,
                    avgRating: serverRankings[0].avgRating || 0,
                    count: serverRankings[0].count
                } : null,
                worstServer: serverRankings.length > 0 ? {
                    name: serverRankings[serverRankings.length - 1].name,
                    avgRating: serverRankings[serverRankings.length - 1].avgRating || 0,
                    count: serverRankings[serverRankings.length - 1].count
                } : null,
                serverRankings,
                categoryRatings,
                willReturn,
                willNotReturn
            };
        }

        res.json(data);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load reports' });
    }
});

// =============================================
// RANKING RESET ROUTES
// =============================================

app.post('/api/admin/reset-rankings', authenticateToken, async (req, res) => {
    try {
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            await db.collection('feedback').deleteMany({});
            await db.collection('feedbackanswers').deleteMany({});
            await db.collection('ranking_resets').updateOne(
                { _id: 'last_reset' },
                { $set: { date: new Date() } },
                { upsert: true }
            );
        } else {
            fallbackData.feedback = [];
            fallbackData.feedbackAnswers = [];
            saveFallbackDataToFile();
            setLastRankingReset();
        }
        res.json({ success: true, message: 'Rankings reset successfully' });
    } catch (err) {
        console.error('Reset rankings error:', err);
        res.status(500).json({ error: 'Failed to reset rankings' });
    }
});

// =============================================
// ADMIN STORAGE & FULL RESET ROUTES
// =============================================

app.get('/api/admin/storage', authenticateToken, async (req, res) => {
    try {
        if (!isMongoConnected) {
            return res.json({ 
                connected: false,
                message: 'Not connected to MongoDB',
                fallback: true
            });
        }
        const db = mongoose.connection.db;
        const stats = await db.stats();
        const dataSizeMB = (stats.dataSize / (1024 * 1024)).toFixed(2);
        const indexSizeMB = (stats.indexSize / (1024 * 1024)).toFixed(2);
        const storageSizeMB = (stats.storageSize / (1024 * 1024)).toFixed(2);
        
        res.json({
            connected: true,
            dataSize: dataSizeMB,
            indexSize: indexSizeMB,
            storageSize: storageSizeMB,
            collections: stats.collections,
            objects: stats.objects
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to get storage info' });
    }
});

app.post('/api/admin/full-reset', authenticateToken, async (req, res) => {
    try {
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const collections = await db.listCollections().toArray();
            for (const collection of collections) {
                await db.collection(collection.name).deleteMany({});
            }
            await seedDatabase();
        } else {
            if (fs.existsSync(FALLBACK_DATA_FILE)) {
                fs.unlinkSync(FALLBACK_DATA_FILE);
            }
            if (fs.existsSync(RANKING_RESET_FILE)) {
                fs.unlinkSync(RANKING_RESET_FILE);
            }
            initializeFallbackData();
        }
        
        res.json({ success: true, message: 'System reset complete. All data has been cleared and default data restored.' });
    } catch (err) {
        console.error('Full reset error:', err);
        res.status(500).json({ error: 'Failed to reset system' });
    }
});

// =============================================
// PDF REPORTS ROUTES
// =============================================
// SETTINGS ROUTES
// =============================================

// Get settings
app.get('/api/settings', authenticateToken, async (req, res) => {
    try {
        let settings = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            settings = await db.collection('settings').findOne({});
            if (!settings) {
                settings = {
                    restaurant_name: 'My Restaurant',
                    description: 'Welcome to our restaurant!',
                    include_server_rating: true,
                    include_comment: true
                };
            }
        } else {
            settings = fallbackData.settings;
        }
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

// Update settings
app.put('/api/settings', authenticateToken, async (req, res) => {
    const { restaurantName, description, includeServerRating, includeComment } = req.body;

    try {
        let settings = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const updateData = { updated_at: new Date() };
            if (restaurantName !== undefined) updateData.restaurant_name = restaurantName;
            if (description !== undefined) updateData.description = description;
            if (includeServerRating !== undefined) updateData.include_server_rating = includeServerRating;
            if (includeComment !== undefined) updateData.include_comment = includeComment;

            const result = await db.collection('settings').findOneAndUpdate(
                {},
                { $set: updateData },
                { upsert: true, returnDocument: 'after' }
            );
            settings = result.value || updateData;
        } else {
            if (restaurantName !== undefined) fallbackData.settings.restaurant_name = restaurantName;
            if (description !== undefined) fallbackData.settings.description = description;
            if (includeServerRating !== undefined) fallbackData.settings.include_server_rating = includeServerRating;
            if (includeComment !== undefined) fallbackData.settings.include_comment = includeComment;
            fallbackData.settings.updated_at = new Date();
            settings = fallbackData.settings;
            saveFallbackDataToFile();
        }

        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// =============================================
// PDF REPORTS ROUTES
// =============================================

// Helper to get common report data
async function getReportData() {
    let data = {};
    if (isMongoConnected) {
        const db = mongoose.connection.db;
        const [
            totalFeedback,
            avgRestaurant,
            avgServer,
            positive,
            negative,
            totalWithRating
        ] = await Promise.all([
            db.collection('feedback').countDocuments(),
            db.collection('feedback').aggregate([
                { $match: { overall_rating: { $ne: null } } },
                { $group: { _id: null, avg: { $avg: '$overall_rating' } } }
            ]).toArray(),
            db.collection('feedback').aggregate([
                { $match: { server_rating: { $ne: null } } },
                { $group: { _id: null, avg: { $avg: '$server_rating' } } }
            ]).toArray(),
            db.collection('feedback').countDocuments({ overall_rating: { $gte: 4 } }),
            db.collection('feedback').countDocuments({ overall_rating: { $lte: 2 } }),
            db.collection('feedback').countDocuments({ overall_rating: { $ne: null } })
        ]);

        const serverRankings = await db.collection('feedback').aggregate([
            { $group: { _id: '$server_id', count: { $sum: 1 }, totalStars: { $sum: '$server_rating' }, avgRating: { $avg: '$server_rating' } } },
            { $lookup: { from: 'servers', localField: '_id', foreignField: '_id', as: 'server' } },
            { $unwind: '$server' },
            { $match: { 'server.status': 'active' } },
            { $sort: { totalStars: -1, avgRating: -1, count: -1 } }
        ]).toArray();

        const categoryRatings = await db.collection('feedbackanswers').aggregate([
            { $lookup: { from: 'questions', localField: 'question_id', foreignField: '_id', as: 'question' } },
            { $unwind: '$question' },
            { $match: { 'question.type': 'star' } },
            { $group: { _id: '$question.category', avgRating: { $avg: { $toDouble: '$answer' } }, count: { $sum: 1 } } },
            { $sort: { avgRating: -1 } }
        ]).toArray();

        const recentFeedback = await db.collection('feedback')
            .find().sort({ created_at: -1 }).limit(20).toArray();

        const serverIds = [...new Set(recentFeedback.map(f => f.server_id))];
        const servers = await db.collection('servers').find({ _id: { $in: serverIds } }).toArray();
        const serverMap = {};
        servers.forEach(s => { serverMap[s._id.toString()] = s.name; });

        data = {
            totalFeedback,
            avgRestaurant: avgRestaurant.length > 0 ? avgRestaurant[0].avg : 0,
            avgServer: avgServer.length > 0 ? avgServer[0].avg : 0,
            positive,
            negative,
            totalWithRating: totalWithRating || 1,
            serverRankings: serverRankings.map(s => ({
                name: s.server.name,
                count: s.count,
                totalStars: s.totalStars || 0,
                avgRating: s.avgRating || 0
            })),
            categoryRatings: categoryRatings.map(c => ({
                category: c._id || 'Uncategorized',
                avgRating: c.avgRating || 0,
                count: c.count
            })),
            recentFeedback: recentFeedback.map(f => ({
                serverName: serverMap[f.server_id.toString()] || 'Unknown',
                overallRating: f.overall_rating,
                serverRating: f.server_rating,
                comment: f.comment,
                createdAt: f.created_at
            }))
        };
    } else {
        const fb = fallbackData.feedback;
        const total = fb.length;
        const totalWithRating = fb.filter(f => f.overall_rating !== null).length || 1;
        const avgRest = totalWithRating > 0 ? fb.reduce((a, b) => a + (b.overall_rating || 0), 0) / totalWithRating : 0;
        const avgServ = fb.filter(f => f.server_rating !== null).length > 0 ?
            fb.reduce((a, b) => a + (b.server_rating || 0), 0) / fb.filter(f => f.server_rating !== null).length : 0;
        const positive = fb.filter(f => f.overall_rating >= 4).length;
        const negative = fb.filter(f => f.overall_rating <= 2).length;

        const serverRankings = fallbackData.servers
            .filter(s => s.status === 'active')
            .map(s => {
                const reviews = fb.filter(f => f.server_id === s.id && f.server_rating !== null);
                const totalStars = reviews.reduce((a, b) => a + (b.server_rating || 0), 0);
                const avg = reviews.length > 0 ? totalStars / reviews.length : 0;
                return { name: s.name, count: reviews.length, totalStars: totalStars, avgRating: avg };
            })
            .filter(s => s.count > 0)
            .sort((a, b) => {
                const starsDiff = (b.totalStars || 0) - (a.totalStars || 0);
                if (starsDiff !== 0) return starsDiff;
                const avgDiff = (b.avgRating || 0) - (a.avgRating || 0);
                if (avgDiff !== 0) return avgDiff;
                return (b.count || 0) - (a.count || 0);
            });

        const categoryRatings = [];
        const categories = {};
        fallbackData.feedbackAnswers.forEach(fa => {
            const question = fallbackData.questions.find(q => q.id === fa.question_id);
            if (question && question.type === 'star') {
                if (!categories[question.category]) categories[question.category] = [];
                categories[question.category].push(parseFloat(fa.answer));
            }
        });
        for (const [category, ratings] of Object.entries(categories)) {
            const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
            categoryRatings.push({ category, avgRating: avg, count: ratings.length });
        }
        categoryRatings.sort((a, b) => b.avgRating - a.avgRating);

        data = {
            totalFeedback: total,
            avgRestaurant: avgRest,
            avgServer: avgServ,
            positive,
            negative,
            totalWithRating,
            serverRankings,
            categoryRatings,
            recentFeedback: fb.slice(-20).reverse().map(f => ({
                serverName: fallbackData.servers.find(s => s.id === f.server_id)?.name || 'Unknown',
                overallRating: f.overall_rating,
                serverRating: f.server_rating,
                comment: f.comment,
                createdAt: f.created_at
            }))
        };
    }
    return data;
}

function generatePDFBuffer(data, title) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.fontSize(20).text(title, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(10).text('Generated on: ' + new Date().toLocaleString(), { align: 'center' });
        doc.moveDown(1);

        doc.fontSize(14).text('Overview', { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(11).text(`Total Feedback: ${data.totalFeedback}`);
        doc.text(`Average Restaurant Rating: ${(data.avgRestaurant || 0).toFixed(1)} / 5`);
        doc.text(`Average Server Rating: ${(data.avgServer || 0).toFixed(1)} / 5`);
        doc.text(`Positive Feedback (4-5): ${data.positive} (${Math.round((data.positive / data.totalWithRating) * 100)}%)`);
        doc.text(`Negative Feedback (1-2): ${data.negative} (${Math.round((data.negative / data.totalWithRating) * 100)}%)`);
        doc.moveDown(1);

        if (data.serverRankings && data.serverRankings.length > 0) {
            doc.fontSize(14).text('Server Performance', { underline: true });
            doc.moveDown(0.3);
            data.serverRankings.forEach(s => {
                doc.fontSize(11).text(`${s.name}: ${s.count} reviews, avg ${(s.avgRating || 0).toFixed(1)} / 5`);
            });
            doc.moveDown(1);
        }

        if (data.categoryRatings && data.categoryRatings.length > 0) {
            doc.fontSize(14).text('Category Performance', { underline: true });
            doc.moveDown(0.3);
            data.categoryRatings.forEach(c => {
                doc.fontSize(11).text(`${c.category}: avg ${(c.avgRating || 0).toFixed(1)} / 5 (${c.count} responses)`);
            });
            doc.moveDown(1);
        }

        if (data.recentFeedback && data.recentFeedback.length > 0) {
            doc.fontSize(14).text('Recent Feedback', { underline: true });
            doc.moveDown(0.3);
            data.recentFeedback.slice(0, 10).forEach(f => {
                doc.fontSize(10).text(`Server: ${f.serverName} | Rating: ${f.overallRating || 0} | Server: ${f.serverRating || 0} | ${f.comment || '-'} | ${new Date(f.createdAt || f.created_at).toLocaleDateString()}`);
            });
        }

        doc.end();
    });
}

// Download full report PDF (authenticated)
app.get('/api/reports/download', authenticateToken, async (req, res) => {
    try {
        const data = await getReportData();
        const pdfBuffer = await generatePDFBuffer(data, 'ServeRate - Full Report');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=serverate-report.pdf');
        res.send(pdfBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// Download server report PDF (authenticated)
app.get('/api/reports/servers/pdf', authenticateToken, async (req, res) => {
    try {
        const data = await getReportData();
        const serverData = {
            totalFeedback: data.totalFeedback,
            avgRestaurant: data.avgRestaurant,
            avgServer: data.avgServer,
            positive: data.positive,
            negative: data.negative,
            totalWithRating: data.totalWithRating,
            serverRankings: data.serverRankings,
            recentFeedback: []
        };
        const pdfBuffer = await generatePDFBuffer(serverData, 'ServeRate - Server Performance Report');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=serverate-servers.pdf');
        res.send(pdfBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// Download category report PDF (authenticated)
app.get('/api/reports/categories/pdf', authenticateToken, async (req, res) => {
    try {
        const data = await getReportData();
        const categoryData = {
            totalFeedback: data.totalFeedback,
            avgRestaurant: data.avgRestaurant,
            avgServer: data.avgServer,
            positive: data.positive,
            negative: data.negative,
            totalWithRating: data.totalWithRating,
            categoryRatings: data.categoryRatings,
            recentFeedback: []
        };
        const pdfBuffer = await generatePDFBuffer(categoryData, 'ServeRate - Category Analysis Report');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=serverate-categories.pdf');
        res.send(pdfBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// =============================================
// SERVE FRONTEND - CATCH ALL ROUTE
// =============================================
// Serve the main index.html for all routes except API
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

// =============================================
// ERROR HANDLING
// =============================================
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// =============================================
// START SERVER
// =============================================
app.listen(PORT, async () => {
    console.log(`\n🚀 ServeRate API running on http://localhost:${PORT}`);
    console.log(`📊 Admin Dashboard: http://localhost:${PORT}/`);
    console.log(`🔑 Login: admin@serverate.com / admin123`);
    console.log(`💾 Mode: ${isMongoConnected ? 'MongoDB' : 'In-Memory (Fallback)'}`);
    console.log(`\n📝 To use MongoDB:`);
    console.log(`   1. Install MongoDB from https://www.mongodb.com/try/download/community`);
    console.log(`   2. Start MongoDB service`);
    console.log(`   3. Or use MongoDB Atlas with MONGODB_URI env variable\n`);
    
    await checkAndResetRankingsIfNeeded();
});