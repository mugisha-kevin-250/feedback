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
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const stream = require('stream');

const app = express();
app.set('trust proxy', 1);

const FALLBACK_DATA_FILE = path.join(__dirname, 'fallback-data.json');

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
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'serveRate-super-secret-key-change-in-production-2026';
const JWT_EXPIRY = '7d';

// Email configuration
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.gmail.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT) || 587;
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

let transporter = null;
function updateEmailTransporter(settings) {
    const host = settings.email_host || process.env.EMAIL_HOST || 'smtp.gmail.com';
    const port = settings.email_port ? parseInt(settings.email_port) : (parseInt(process.env.EMAIL_PORT) || 587);
    const user = settings.email_user || process.env.EMAIL_USER || '';
    const pass = settings.email_pass || process.env.EMAIL_PASS || '';
    const from = settings.email_from || process.env.EMAIL_FROM || user;

    if (user && pass) {
        transporter = nodemailer.createTransport({
            host: host,
            port: port,
            secure: port === 465,
            auth: { user: user, pass: pass }
        });
        console.log('✅ Email transporter updated from settings');
    } else {
        transporter = null;
        console.log('⚠️ Email transporter disabled: missing credentials');
    }

    return { host, port, user, from };
}
if (EMAIL_USER && EMAIL_PASS) {
    updateEmailTransporter({
        email_host: EMAIL_HOST,
        email_port: EMAIL_PORT,
        email_user: EMAIL_USER,
        email_pass: EMAIL_PASS,
        email_from: EMAIL_FROM
    });
}

// =============================================
// MIDDLEWARE
// =============================================
app.use(cors());
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

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
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
    loadEmailSettings();
})
.catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Please make sure MongoDB is running:');
    console.log('   - Local: mongodb://localhost:27017');
    console.log('   - Or use MongoDB Atlas with MONGODB_URI env variable');
    console.log('💾 Using in-memory fallback mode...');
    isMongoConnected = false;
    initializeFallbackData();
    loadEmailSettings();
});

async function loadEmailSettings() {
    try {
        let settings = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            settings = await db.collection('settings').findOne({});
        } else {
            settings = fallbackData.settings;
        }
        if (settings) {
            updateEmailTransporter({
                email_host: settings.email_host || '',
                email_port: settings.email_port || 587,
                email_user: settings.email_user || '',
                email_pass: settings.email_pass || '',
                email_from: settings.email_from || ''
            });
        }
    } catch (err) {
        console.error('Failed to load email settings on startup:', err);
    }
}

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
            { id: 'q6', text: 'Would you recommend us?', category: 'Recommendation', type: 'yes_no', options: [], required: true, active: true, display_order: 6, created_at: new Date(), updated_at: new Date() },
            { id: 'q7', text: 'What did you like most?', category: 'Feedback', type: 'multiple_choice', options: ['Food', 'Service', 'Atmosphere', 'Cleanliness', 'Price', 'Other'], required: false, active: true, display_order: 7, created_at: new Date(), updated_at: new Date() },
            { id: 'q8', text: 'Additional comments', category: 'Feedback', type: 'text', options: [], required: false, active: true, display_order: 8, created_at: new Date(), updated_at: new Date() }
        ],
        feedback: [],
        feedbackAnswers: [],
        customers: [],
        settings: {
            restaurant_name: 'My Restaurant',
            description: 'Welcome to our restaurant!',
            include_server_rating: true,
            include_comment: true,
            email_host: '',
            email_port: 587,
            email_user: '',
            email_pass: '',
            email_from: '',
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
                { text: 'Would you recommend us?', category: 'Recommendation', type: 'yes_no', options: [], required: true, active: true, display_order: 6 },
                { text: 'What did you like most?', category: 'Feedback', type: 'multiple_choice', options: ['Food', 'Service', 'Atmosphere', 'Cleanliness', 'Price', 'Other'], required: false, active: true, display_order: 7 },
                { text: 'Additional comments', category: 'Feedback', type: 'text', options: [], required: false, active: true, display_order: 8 }
            ];
            for (const q of defaultQuestions) {
                await db.collection('questions').insertOne({
                    ...q,
                    created_at: new Date(),
                    updated_at: new Date()
                });
            }
            console.log('✅ Default questions created');
        }

        // Check if we have settings
        if (!collectionNames.includes('settings') || await db.collection('settings').countDocuments() === 0) {
            await db.collection('settings').insertOne({
                restaurant_name: 'My Restaurant',
                description: 'Welcome to our restaurant!',
                include_server_rating: true,
                include_comment: true,
                email_host: '',
                email_port: 587,
                email_user: '',
                email_pass: '',
                email_from: '',
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
            if (user) password_hash = user.password_hash;
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
            { id: user.id || user._id, email: user.email, name: user.name },
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
app.get('/api/auth/verify',  (req, res) => {
    res.json({ valid: true, user: req.user });
});

// =============================================
// SERVER ROUTES
// =============================================

// Get all servers
app.get('/api/servers',  async (req, res) => {
    try {
        let servers = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            servers = await db.collection('servers').find().sort({ name: 1 }).toArray();
            
            const serverIds = servers.map(s => s._id);
            const feedbackStats = await db.collection('feedback').aggregate([
                { $match: { server_id: { $in: serverIds }, overall_rating: { $ne: null } } },
                { $group: { 
                    _id: '$server_id', 
                    avgRating: { $avg: '$overall_rating' }, 
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
                employeeId: s.employee_id,
                phone: s.phone,
                status: s.status,
                avgRating: statsMap[s._id.toString()]?.avgRating || 0,
                reviewCount: statsMap[s._id.toString()]?.reviewCount || 0
            }));
        } else {
            servers = fallbackData.servers.map(s => {
                const serverFeedback = fallbackData.feedback.filter(f => f.server_id === s.id && f.overall_rating !== null);
                const avgRating = serverFeedback.length > 0 
                    ? Math.round((serverFeedback.reduce((a, b) => a + (b.overall_rating || 0), 0) / serverFeedback.length) * 10) / 10 
                    : 0;
                return {
                    id: s.id,
                    name: s.name,
                    employeeId: s.employee_id,
                    phone: s.phone,
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
            servers = servers.map(s => ({
                id: s._id,
                name: s.name,
                employeeId: s.employee_id,
                phone: s.phone,
                status: s.status,
                createdAt: s.created_at,
                updatedAt: s.updated_at
            }));
        } else {
            servers = fallbackData.servers.filter(s => s.status === 'active');
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
                { $match: { server_id: { $in: serverIds }, overall_rating: { $ne: null } } },
                { $group: { 
                    _id: '$server_id', 
                    avgRating: { $avg: '$overall_rating' }, 
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
                employeeId: s.employee_id,
                phone: s.phone,
                status: s.status,
                avgRating: statsMap[s._id.toString()]?.avgRating || 0,
                reviewCount: statsMap[s._id.toString()]?.reviewCount || 0
            }));
        } else {
            servers = fallbackData.servers.filter(s => s.status === 'active').map(s => {
                const serverFeedback = fallbackData.feedback.filter(f => f.server_id === s.id && f.overall_rating !== null);
                const avgRating = serverFeedback.length > 0 
                    ? Math.round((serverFeedback.reduce((a, b) => a + (b.overall_rating || 0), 0) / serverFeedback.length) * 10) / 10 
                    : 0;
                return {
                    id: s.id,
                    name: s.name,
                    employeeId: s.employee_id,
                    phone: s.phone,
                    status: s.status,
                    avgRating: avgRating,
                    reviewCount: serverFeedback.length
                };
            });
        }
        
        servers.sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0));
        res.json(servers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load ranked servers' });
    }
});

// Create server
app.post('/api/servers',  [
    body('name').notEmpty().withMessage('Server name required'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { name, employeeId, phone, status = 'active' } = req.body;

    try {
        let server = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const result = await db.collection('servers').insertOne({
                name,
                employee_id: employeeId || null,
                phone: phone || null,
                status,
                created_at: new Date(),
                updated_at: new Date()
            });
            server = {
                id: result.insertedId,
                name,
                employeeId: employeeId || null,
                phone: phone || null,
                status
            };
        } else {
            server = {
                id: generateId(),
                name,
                employee_id: employeeId || null,
                phone: phone || null,
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
app.put('/api/servers/:id',  async (req, res) => {
    const id = req.params.id;
    const { name, employeeId, phone, status } = req.body;

    try {
        let server = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const updateData = { updated_at: new Date() };
            if (name !== undefined) updateData.name = name;
            if (employeeId !== undefined) updateData.employee_id = employeeId || null;
            if (phone !== undefined) updateData.phone = phone || null;
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
                employeeId: result.value.employee_id,
                phone: result.value.phone,
                status: result.value.status
            };
        } else {
            const index = fallbackData.servers.findIndex(s => s.id === id);
            if (index === -1) {
                return res.status(404).json({ error: 'Server not found' });
            }
            if (name !== undefined) fallbackData.servers[index].name = name;
            if (employeeId !== undefined) fallbackData.servers[index].employee_id = employeeId || null;
            if (phone !== undefined) fallbackData.servers[index].phone = phone || null;
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
app.delete('/api/servers/:id',  async (req, res) => {
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
app.get('/api/questions',  async (req, res) => {
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
app.post('/api/questions',  [
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
app.put('/api/questions/:id',  async (req, res) => {
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
app.delete('/api/questions/:id',  async (req, res) => {
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

    const { serverId, answers = [], serverRating, comment, deviceInfo = {} } = req.body;

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

        if (overallRating === null && serverRating !== undefined) {
            overallRating = parseFloat(serverRating);
        }

        let feedbackId = null;

        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const result = await db.collection('feedback').insertOne({
                server_id: serverId,
                overall_rating: overallRating,
                server_rating: serverRating || null,
                comment: comment || null,
                device_info: deviceInfo,
                created_at: new Date()
            });
            feedbackId = result.insertedId;

            // Create answers
            for (const answer of answers) {
                if (answer.answer !== null && answer.answer !== undefined && answer.answer !== '') {
                    await db.collection('feedbackanswers').insertOne({
                        feedback_id: feedbackId,
                        question_id: answer.questionId,
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
app.get('/api/feedback',  async (req, res) => {
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
            if (serverId) filter.server_id = serverId;
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
                .find({ _id: { $in: serverIds.map(id => new mongoose.Types.ObjectId(id)) } })
                .toArray();
            const serverMap = {};
            servers.forEach(s => { serverMap[s._id.toString()] = s.name; });

            items = feedbacks.map(f => ({
                id: f._id,
                serverId: f.server_id,
                serverName: serverMap[f.server_id.toString()] || 'Unknown',
                overallRating: f.overall_rating,
                serverRating: f.server_rating,
                comment: f.comment,
                createdAt: f.created_at
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

            items = paginated.map(f => ({
                id: f.id,
                serverId: f.server_id,
                serverName: serverMap[f.server_id] || 'Unknown',
                overallRating: f.overall_rating,
                serverRating: f.server_rating,
                comment: f.comment,
                createdAt: f.created_at
            }));
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
app.get('/api/feedback/:id',  async (req, res) => {
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

            const server = await db.collection('servers').findOne({ _id: new mongoose.Types.ObjectId(feedback.server_id) });
            const feedbackAnswers = await db.collection('feedbackanswers')
                .find({ feedback_id: id })
                .toArray();
            
            const questionIds = feedbackAnswers.map(fa => fa.question_id);
            const questions = await db.collection('questions')
                .find({ _id: { $in: questionIds.map(qid => new mongoose.Types.ObjectId(qid)) } })
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
app.get('/api/customers',  async (req, res) => {
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

// Download customers as CSV (authenticated)
app.get('/api/customers/download',  async (req, res) => {
    try {
        let customers = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            customers = await db.collection('customers').find().sort({ created_at: -1 }).toArray();
        } else {
            customers = [...fallbackData.customers].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }

        const csvHeader = 'Name,Email,Phone,Date\n';
        const csvRows = customers.map(c => {
            const date = new Date(c.created_at).toLocaleDateString();
            return `"${(c.name || '').replace(/"/g, '""')}","${(c.email || '').replace(/"/g, '""')}","${(c.phone || '').replace(/"/g, '""')}","${date}"`;
        }).join('\n');

        const csv = csvHeader + csvRows;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
        res.send(csv);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to download customers' });
    }
});

// =============================================
// EMAIL ROUTES
// =============================================

// Send announcement to all customers (authenticated)
app.post('/api/email/send-announcement',  [
    body('subject').notEmpty().withMessage('Subject is required'),
    body('body').notEmpty().withMessage('Email body is required'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { subject, body: emailBody } = req.body;

    try {
        let customers = [];
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            customers = await db.collection('customers').find().toArray();
        } else {
            customers = fallbackData.customers;
        }

        if (customers.length === 0) {
            return res.status(400).json({ error: 'No customers to email' });
        }

        let currentSettings = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            currentSettings = await db.collection('settings').findOne({});
        } else {
            currentSettings = fallbackData.settings;
        }

        const host = currentSettings?.email_host || process.env.EMAIL_HOST || 'smtp.gmail.com';
        const port = currentSettings?.email_port ? parseInt(currentSettings.email_port) : (parseInt(process.env.EMAIL_PORT) || 587);
        const user = currentSettings?.email_user || process.env.EMAIL_USER || '';
        const pass = currentSettings?.email_pass || process.env.EMAIL_PASS || '';
        const from = currentSettings?.email_from || process.env.EMAIL_FROM || user;

        if (!user || !pass) {
            return res.status(500).json({ error: 'Email service not configured. Please configure SMTP settings in the admin panel (Announcements tab).' });
        }

        const mailTransporter = nodemailer.createTransport({
            host: host,
            port: port,
            secure: port === 465,
            auth: { user: user, pass: pass }
        });

        const mailOptions = {
            from: from,
            bcc: customers.map(c => c.email),
            subject: subject,
            text: emailBody,
            html: `<p>${emailBody.replace(/\n/g, '<br>')}</p>`
        };

        await mailTransporter.sendMail(mailOptions);
        res.json({ success: true, message: `Announcement sent to ${customers.length} customers` });
    } catch (err) {
        console.error('Email sending error:', err);
        res.status(500).json({ error: 'Failed to send announcement: ' + err.message });
    }
});

// =============================================
// ANALYTICS ROUTES
// =============================================

// Dashboard analytics
app.get('/api/analytics/dashboard',  async (req, res) => {
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
                .find({ _id: { $in: serverIds.map(id => new mongoose.Types.ObjectId(id)) } })
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
app.get('/api/analytics/reports',  async (req, res) => {
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
                {
                    $group: {
                        _id: '$server_id',
                        count: { $sum: 1 },
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
                { $sort: { avgRating: -1 } }
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
                    avgRating: s.avgRating || 0
                })),
                categoryRatings: categoryRatings.map(c => ({
                    category: c._id || 'Uncategorized',
                    avgRating: c.avgRating || 0,
                    count: c.count
                }))
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
                    const avg = reviews.length > 0 ? reviews.reduce((a, b) => a + (b.server_rating || 0), 0) / reviews.length : 0;
                    return { 
                        id: s.id, 
                        name: s.name, 
                        count: reviews.length, 
                        avgRating: avg 
                    };
                })
                .filter(s => s.count > 0)
                .sort((a, b) => b.avgRating - a.avgRating);

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
                categoryRatings
            };
        }

        res.json(data);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load reports' });
    }
});

// =============================================
// SETTINGS ROUTES
// =============================================

// Get settings
app.get('/api/settings',  async (req, res) => {
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
                    include_comment: true,
                    email_host: '',
                    email_port: 587,
                    email_user: '',
                    email_pass: '',
                    email_from: ''
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
app.put('/api/settings',  async (req, res) => {
    const { restaurantName, description, includeServerRating, includeComment, emailHost, emailPort, emailUser, emailPass, emailFrom, email_host, email_port, email_user, email_pass, email_from } = req.body;

    try {
        let settings = null;
        if (isMongoConnected) {
            const db = mongoose.connection.db;
            const updateData = { updated_at: new Date() };
            if (restaurantName !== undefined) updateData.restaurant_name = restaurantName;
            if (description !== undefined) updateData.description = description;
            if (includeServerRating !== undefined) updateData.include_server_rating = includeServerRating;
            if (includeComment !== undefined) updateData.include_comment = includeComment;
            if (emailHost !== undefined || email_host !== undefined) updateData.email_host = emailHost || email_host;
            if (emailPort !== undefined || email_port !== undefined) updateData.email_port = emailPort || email_port;
            if (emailUser !== undefined || email_user !== undefined) updateData.email_user = emailUser || email_user;
            if (emailPass !== undefined || email_pass !== undefined) updateData.email_pass = emailPass || email_pass;
            if (emailFrom !== undefined || email_from !== undefined) updateData.email_from = emailFrom || email_from;

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
            if (emailHost !== undefined || email_host !== undefined) fallbackData.settings.email_host = emailHost || email_host;
            if (emailPort !== undefined || email_port !== undefined) fallbackData.settings.email_port = emailPort || email_port;
            if (emailUser !== undefined || email_user !== undefined) fallbackData.settings.email_user = emailUser || email_user;
            if (emailPass !== undefined || email_pass !== undefined) fallbackData.settings.email_pass = emailPass || email_pass;
            if (emailFrom !== undefined || email_from !== undefined) fallbackData.settings.email_from = emailFrom || email_from;
            fallbackData.settings.updated_at = new Date();
            settings = fallbackData.settings;
            saveFallbackDataToFile();
        }

        updateEmailTransporter(settings);

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
            { $group: { _id: '$server_id', count: { $sum: 1 }, avgRating: { $avg: '$server_rating' } } },
            { $lookup: { from: 'servers', localField: '_id', foreignField: '_id', as: 'server' } },
            { $unwind: '$server' },
            { $match: { 'server.status': 'active' } },
            { $sort: { avgRating: -1 } }
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
                avgRating: s.avgRating || 0
            })),
            categoryRatings: categoryRatings.map(c => ({
                category: c._id || 'Uncategorized',
                avgRating: c.avgRating || 0,
                count: c.count
            })),
            recentFeedback: recentFeedback.map(f => ({
                serverName: f.server_id,
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
                const avg = reviews.length > 0 ? reviews.reduce((a, b) => a + (b.server_rating || 0), 0) / reviews.length : 0;
                return { name: s.name, count: reviews.length, avgRating: avg };
            })
            .filter(s => s.count > 0)
            .sort((a, b) => b.avgRating - a.avgRating);

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
app.get('/api/reports/download',  async (req, res) => {
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
app.get('/api/reports/servers/pdf',  async (req, res) => {
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
app.get('/api/reports/categories/pdf',  async (req, res) => {
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
app.listen(PORT, () => {
    console.log(`\n🚀 ServeRate API running on http://localhost:${PORT}`);
    console.log(`📊 Admin Dashboard: http://localhost:${PORT}/`);
    console.log(`🔑 Login: admin@serverate.com / admin123`);
    console.log(`💾 Mode: ${isMongoConnected ? 'MongoDB' : 'In-Memory (Fallback)'}`);
    console.log(`\n📝 To use MongoDB:`);
    console.log(`   1. Install MongoDB from https://www.mongodb.com/try/download/community`);
    console.log(`   2. Start MongoDB service`);
    console.log(`   3. Or use MongoDB Atlas with MONGODB_URI env variable\n`);
});