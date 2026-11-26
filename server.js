const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DEFAULT_DB = {
  users: [
    {
      key: 'fil1an',
      nick: 'Fil1an',
      email: 'kayzenofficialtt@gmail.com',
      salt: 'zn7bd30731b7576e76',
      hash: '36cd02b22aea2ff923ad1c8f419f501f62500d0b07a88eee6c9956d193a0008c',
      role: 'admin',
      banned: false,
      avatar: null,
      banner: null,
      bio: '',
      kind: 'both',
      privateProfile: false,
      showEmail: false,
      showPlaylists: true
    }
  ],
  songs: [],
  playlists: [],
  likes: {},          // { trackId: ['userKey1'] }
  saved: {},          // { userKey: ['trackId1'] }
  views: {},          // { trackId: 42 }
  comments: {},       // { trackId: [{ id, user, nick, text, at }] }
  follows: {},        // { followerKey: ['targetKey1'] }
  favArtists: {},     // { userKey: ['Artist 1'] }
  hiddenArtists: [],  // ['Artist Name']
  customArtists: [],  // ['Artist Name']
  artistCovers: {}    // { 'Artist Name': '/uploads/...' }
};

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...DEFAULT_DB, ...parsed };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

let db = loadDB();
const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

function removeFileIfLocal(u) {
  if (u && typeof u === 'string' && u.startsWith('/uploads/')) {
    const p = path.join(__dirname, u);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (e) {}
    }
  }
}

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 150 * 1024 * 1024 } });

// --- ПОЛНОЕ СОСТОЯНИЕ ---
app.get('/api/state', (req, res) => {
  const safeUsers = db.users.map(({ hash, salt, ...u }) => u);
  res.json({
    users: safeUsers,
    songs: db.songs,
    playlists: db.playlists,
    likes: db.likes,
    saved: db.saved,
    views: db.views,
    comments: db.comments,
    follows: db.follows,
    favArtists: db.favArtists,
    hiddenArtists: db.hiddenArtists,
    customArtists: db.customArtists,
    artistCovers: db.artistCovers
  });
});

// --- АВТОРИЗАЦИЯ И ПРОФИЛИ ---
app.post('/api/auth/register', (req, res) => {
  const { key, nick, email, salt, hash, kind } = req.body;
  if (!key || !nick || !email || !hash) return res.status(400).json({ error: 'Неполные данные' });
  if (db.users.some(u => u.key === key || u.nick.toLowerCase() === nick.toLowerCase())) {
    return res.status(409).json({ error: 'Этот ник уже занят' });
  }
  if (db.users.some(u => u.email === email)) {
    return res.status(409).json({ error: 'Эта почта уже зарегистрирована' });
  }
  const user = {
    key, nick, email, salt, hash,
    role: 'user', banned: false, avatar: null, banner: null, bio: '',
    kind: kind || 'listener', privateProfile: false, showEmail: false, showPlaylists: true
  };
  db.users.push(user);
  saveDB();
  res.json(user);
});

app.post('/api/auth/login', (req, res) => {
  const { id, hash } = req.body;
  const q = String(id || '').toLowerCase();
  const user = db.users.find(u => u.key === q || u.email === q || u.nick.toLowerCase() === q);
  if (!user) return res.status(404).json({ error: 'Неверный ник или пароль' });
  if (user.banned) return res.status(403).json({ error: 'Аккаунт заблокирован модератором' });
  if (!hash) {
    // Отдаём только соль для расчёта хэша на клиенте
    return res.json({ salt: user.salt, key: user.key });
  }
  if (user.hash !== hash) return res.status(401).json({ error: 'Неверный ник или пароль' });
  res.json(user);
});

app.put('/api/users/:key', upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), (req, res) => {
  const u = db.users.find(x => x.key === req.params.key);
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  const { nick, bio, kind, privateProfile, showEmail, showPlaylists, hash, salt } = req.body;
  if (nick && u.key !== 'fil1an') {
    const l = nick.toLowerCase();
    if (db.users.some(x => x.key !== u.key && (x.key === l || x.nick.toLowerCase() === l))) {
      return res.status(409).json({ error: 'Этот ник уже занят' });
    }
    u.nick = nick;
    db.songs.forEach(s => { if (s.owner === u.key && !s.perf) s.artist = nick; });
    db.playlists.forEach(p => { if (p.owner === u.key) p.ownerNick = nick; });
  }
  if (bio !== undefined) u.bio = String(bio).slice(0, 180);
  if (kind) u.kind = kind;
  if (privateProfile !== undefined) u.privateProfile = privateProfile === 'true' || privateProfile === true;
  if (showEmail !== undefined) u.showEmail = showEmail === 'true' || showEmail === true;
  if (showPlaylists !== undefined) u.showPlaylists = showPlaylists === 'true' || showPlaylists === true;
  if (hash && salt) { u.hash = hash; u.salt = salt; }
  if (req.files?.avatar?.[0]) {
    removeFileIfLocal(u.avatar);
    u.avatar = '/uploads/' + req.files.avatar[0].filename;
  }
  if (req.files?.banner?.[0]) {
    removeFileIfLocal(u.banner);
    u.banner = '/uploads/' + req.files.banner[0].filename;
  }
  saveDB();
  res.json(u);
});

app.post('/api/users/:key/fav-artists', (req, res) => {
  const { artists } = req.body;
  if (Array.isArray(artists)) {
    db.favArtists[req.params.key] = artists;
    saveDB();
  }
  res.json({ ok: true });
});

// --- ПЕСНИ ---
app.post('/api/songs', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
  { name: 'video', maxCount: 1 }
]), (req, res) => {
  if (!req.files?.audio?.[0]) return res.status(400).json({ error: 'Нужен аудиофайл' });
  const b = req.body;
  const song = {
    id: 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    title: b.title || 'Без названия',
    owner: b.owner,
    artist: b.artist || 'Неизвестный',
    perf: b.perf === 'true',
    fname: req.files.audio[0].originalname,
    lyrics: b.lyrics || '',
    lrc: b.lrc || '',
    url: '/uploads/' + req.files.audio[0].filename,
    cover: req.files.cover?.[0] ? '/uploads/' + req.files.cover[0].filename : null,
    video: req.files.video?.[0] ? '/uploads/' + req.files.video[0].filename : null,
    kind: b.kind || 'web',
    hue: Number(b.hue) || 260,
    dur: Number(b.dur) || 0,
    size: req.files.audio[0].size,
    mime: req.files.audio[0].mimetype,
    added: Date.now()
  };
  db.songs.push(song);
  saveDB();
  res.json(song);
});

app.put('/api/songs/:id', upload.single('cover'), (req, res) => {
  const s = db.songs.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Трек не найден' });
  const { title, artist, lyrics, lrc } = req.body;
  if (title) s.title = title;
  if (artist) { s.artist = artist; s.perf = true; }
  if (lyrics !== undefined) s.lyrics = lyrics;
  if (lrc !== undefined) s.lrc = lrc;
  if (req.file) {
    removeFileIfLocal(s.cover);
    s.cover = '/uploads/' + req.file.filename;
  }
  saveDB();
  res.json(s);
});

app.delete('/api/songs/:id', (req, res) => {
  const idx = db.songs.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Не найден' });
  const [removed] = db.songs.splice(idx, 1);
  [removed.url, removed.cover, removed.video].forEach(removeFileIfLocal);
  db.playlists.forEach(p => { p.ids = p.ids.filter(i => i !== req.params.id); });
  delete db.likes[req.params.id];
  delete db.comments[req.params.id];
  delete db.views[req.params.id];
  saveDB();
  res.json({ ok: true });
});

// --- СОЦИАЛЬНЫЕ ВЗАИМОДЕЙСТВИЯ ---
app.post('/api/songs/:id/like', (req, res) => {
  const { userKey } = req.body;
  if (!userKey) return res.status(400).json({ error: 'Нет userKey' });
  const list = db.likes[req.params.id] || (db.likes[req.params.id] = []);
  const i = list.indexOf(userKey);
  if (i >= 0) list.splice(i, 1); else list.push(userKey);
  saveDB();
  res.json({ liked: i < 0, count: list.length });
});

app.post('/api/songs/:id/save', (req, res) => {
  const { userKey } = req.body;
  if (!userKey) return res.status(400).json({ error: 'Нет userKey' });
  const list = db.saved[userKey] || (db.saved[userKey] = []);
  const i = list.indexOf(req.params.id);
  if (i >= 0) list.splice(i, 1); else list.push(req.params.id);
  saveDB();
  res.json({ saved: i < 0 });
});

app.post('/api/songs/:id/view', (req, res) => {
  db.views[req.params.id] = (db.views[req.params.id] || 0) + 1;
  saveDB();
  res.json({ views: db.views[req.params.id] });
});

app.post('/api/songs/:id/comments', (req, res) => {
  const { user, nick, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Пустой комментарий' });
  const list = db.comments[req.params.id] || (db.comments[req.params.id] = []);
  const item = {
    id: 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    user, nick, text: text.trim().slice(0, 500), at: Date.now()
  };
  list.push(item);
  saveDB();
  res.json(item);
});

app.delete('/api/songs/:id/comments/:cid', (req, res) => {
  const list = db.comments[req.params.id] || [];
  db.comments[req.params.id] = list.filter(c => c.id !== req.params.cid);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/follow', (req, res) => {
  const { from, to } = req.body;
  const list = db.follows[from] || (db.follows[from] = []);
  const i = list.indexOf(to);
  if (i >= 0) list.splice(i, 1); else list.push(to);
  saveDB();
  res.json({ following: i < 0 });
});

// --- ПЛЕЙЛИСТЫ ---
app.post('/api/playlists', upload.single('cover'), (req, res) => {
  const b = req.body;
  const pl = {
    id: 'p_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    n: b.n,
    desc: b.desc || '',
    owner: b.owner,
    ownerNick: b.ownerNick,
    h: Number(b.h) || 200,
    ids: b.ids ? JSON.parse(b.ids) : [],
    cover: req.file ? '/uploads/' + req.file.filename : null,
    added: Date.now()
  };
  db.playlists.push(pl);
  saveDB();
  res.json(pl);
});

app.put('/api/playlists/:id', upload.single('cover'), (req, res) => {
  const pl = db.playlists.find(x => x.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Плейлист не найден' });
  if (req.body.n) pl.n = req.body.n;
  if (req.body.desc !== undefined) pl.desc = req.body.desc;
  if (req.body.ids) pl.ids = JSON.parse(req.body.ids);
  if (req.file) {
    removeFileIfLocal(pl.cover);
    pl.cover = '/uploads/' + req.file.filename;
  }
  saveDB();
  res.json(pl);
});

app.delete('/api/playlists/:id', (req, res) => {
  const pl = db.playlists.find(x => x.id === req.params.id);
  if (pl) removeFileIfLocal(pl.cover);
  db.playlists = db.playlists.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

// --- АРТИСТЫ И МОДЕРАЦИЯ ---
app.post('/api/artists/cover', upload.single('cover'), (req, res) => {
  const { name } = req.body;
  if (!name || !req.file) return res.status(400).json({ error: 'Нужны имя и файл' });
  removeFileIfLocal(db.artistCovers[name]);
  db.artistCovers[name] = '/uploads/' + req.file.filename;
  saveDB();
  res.json({ url: db.artistCovers[name] });
});

app.delete('/api/artists/cover/:name', (req, res) => {
  const name = req.params.name;
  removeFileIfLocal(db.artistCovers[name]);
  delete db.artistCovers[name];
  saveDB();
  res.json({ ok: true });
});

app.post('/api/artists/manage', (req, res) => {
  const { action, name } = req.body;
  if (!name) return res.status(400).json({ error: 'Нет имени' });
  if (action === 'delete') {
    if (!db.hiddenArtists.includes(name)) db.hiddenArtists.push(name);
    db.customArtists = db.customArtists.filter(x => x !== name);
  } else if (action === 'restore') {
    db.hiddenArtists = db.hiddenArtists.filter(x => x !== name);
  } else if (action === 'add') {
    db.hiddenArtists = db.hiddenArtists.filter(x => x !== name);
    if (!db.customArtists.includes(name)) db.customArtists.push(name);
  }
  saveDB();
  res.json({ ok: true });
});

app.post('/api/admin/ban/:key', (req, res) => {
  const u = db.users.find(x => x.key === req.params.key);
  if (!u || u.key === 'fil1an') return res.status(400).json({ error: 'Нельзя' });
  u.banned = !u.banned;
  saveDB();
  res.json({ banned: u.banned });
});

app.delete('/api/admin/users/:key', (req, res) => {
  const k = req.params.key;
  if (k === 'fil1an') return res.status(400).json({ error: 'Нельзя' });
  db.users = db.users.filter(x => x.key !== k);
  db.songs.filter(x => x.owner === k).forEach(s => [s.url, s.cover, s.video].forEach(removeFileIfLocal));
  db.songs = db.songs.filter(x => x.owner !== k);
  db.playlists = db.playlists.filter(x => x.owner !== k);
  saveDB();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`ZENITH Server запущен: http://localhost:${PORT}`));
