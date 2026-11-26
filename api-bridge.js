(function () {
  
  // Поддержка работы из APK (file:// или WebView) с удалённым сервером
  const DEFAULT_SERVER = window.ZENITH_SERVER_URL || localStorage.getItem('zenithServerUrl') || '';
  const BASE_URL = DEFAULT_SERVER.replace(/\/+$/, '');
  const API = BASE_URL ? `${BASE_URL}/api` : '/api';

  function fixMediaUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (BASE_URL && u.startsWith('/uploads/')) return BASE_URL + u;
    return u;
  }

  // Перехват fetch для автоматической подстановки BASE_URL ко всем /api/ запросам
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    if (typeof input === 'string' && input.startsWith('/api') && BASE_URL) {
      input = BASE_URL + input;
    }
    return origFetch(input, init);
  };

  let serverLikes = {};

  // Переопределяем подсчёт лайков на общесерверный
  likeCount = id => (serverLikes[id] || []).length;

  async function syncFromServer() {
    try {
      const res = await fetch(`${API}/state`);
      if (!res.ok) return;
      const state = await res.json();

      // 1. Треки
      T.length = 0;
      state.songs.forEach(s => {
        s.url = fixMediaUrl(s.url);
        s.cover = fixMediaUrl(s.cover);
        s.video = fixMediaUrl(s.video);
        T.push({
          ...s,
          type: 'file',
          rec: {
            ...s,
            audio: { size: s.size || 0, type: s.mime || 'audio/mpeg' }
          }
        });
      });

      // 2. Плейлисты
      PL.length = 0;
      state.playlists.forEach(p => {
        p.cover = fixMediaUrl(p.cover);
        p.cu = p.cover;
        PL.push(p);
      });

      // 3. Пользователи, просмотры, комментарии, подписки, лайки
      state.users.forEach(u => { u.avatar = fixMediaUrl(u.avatar); u.banner = fixMediaUrl(u.banner); });
      const adm = state.users.find(u => u.key === ADMIN.key);
      if (adm) Object.assign(ADMIN, adm);
      UL = state.users.filter(u => u.key !== ADMIN.key);

      serverLikes = state.likes || {};
      songViews = state.views || {};
      songComments = state.comments || {};
      FW = state.follows || {};

      // Обложки и списки артистов от модератора
      const fixedCovers = {}; Object.entries(state.artistCovers || {}).forEach(([k, v]) => fixedCovers[k] = fixMediaUrl(v)); Object.assign(PH, fixedCovers);
      (state.customArtists || []).forEach(n => {
        if (!AR.some(a => a.n.toLowerCase() === n.toLowerCase())) AR.unshift({ n, t: ' custom ' });
      });
      (state.hiddenArtists || []).forEach(n => {
        HA.add(n);
        const i = AR.findIndex(a => a.n === n);
        if (i >= 0) { ARX[n] = AR[i]; AR.splice(i, 1); }
      });

      if (me) {
        const freshMe = state.users.find(u => u.key === me.key);
        if (freshMe) {
          if (freshMe.banned) { logout(); return toast('Аккаунт заблокирован модератором'); }
          me = freshMe;
        }
        liked = new Set(
          Object.entries(serverLikes)
            .filter(([, users]) => users.includes(me.key))
            .map(([tid]) => tid)
        );
        savedTracks = new Set((state.saved && state.saved[me.key]) || []);
        if (state.favArtists && state.favArtists[me.key]) {
          FA = state.favArtists[me.key];
        }
      }

      markBans(UL);
      side();
      meBox();
      render();
      markLikes();
    } catch (e) {
      console.warn('Сервер недоступен, работаем локально', e);
    }
  }

  // Авторизация / Регистрация
  doAuth = async function () {
    const err = m => { $('#ar').textContent = m; };
    err('');
    const nick = $('#an').value.trim();
    const pw = $('#ap').value;
    const em = $('#ae').value.trim().toLowerCase();
    const id = nick.toLowerCase();

    try {
      if (AM === 'in') {
        const probe = await fetch(`${API}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const probeData = await probe.json();
        if (!probe.ok) return err(probeData.error || 'Неверный ник или пароль');

        const computedHash = hp(pw, probeData.salt);
        const loginRes = await fetch(`${API}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, hash: computedHash })
        });
        const authed = await loginRes.json();
        if (!loginRes.ok) return err(authed.error || 'Неверный ник или пароль');

        setMe(authed);
        await syncFromServer();
        return;
      }

      if (!/^[\wА-Яа-яЁё.-]{3,20}$/.test(nick)) return err('Ник: 3–20 символов, буквы, цифры, _ . -');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err('Введите корректную почту');
      if (pw.length < 6) return err('Пароль: минимум 6 символов');

      const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const regRes = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: id, nick, email: em, salt, hash: hp(pw, salt),
          kind: ($('#ak .on') || { dataset: {} }).dataset.kd || 'listener'
        })
      });
      const created = await regRes.json();
      if (!regRes.ok) return err(created.error || 'Ошибка регистрации');

      setMe(created);
      await syncFromServer();
      pickArtists(1);
    } catch (e) {
      err('Нет связи с сервером');
    }
  };

  // Загрузка новой песни на сервер
  saveSong = async function () {
    const e = m => { $('#se').textContent = m; };
    const n = $('#sn').value.trim();
    const af = $('#sa').files[0];
    const cf = $('#sc').files[0];
    const vf = $('#sv') && $('#sv').files[0];

    if (!n) return e('Введите название песни');
    if (!af || !/^audio\//.test(af.type || 'audio/')) return e('Выберите аудиофайл');
    if (cf && !/^image\//.test(cf.type)) return e('Обложка должна быть картинкой');
    if (vf) {
      if (!/^video\//.test(vf.type)) return e('Видео-обложка должна быть видеофайлом');
      e('Проверяю видео…');
      const d = await vdur(vf);
      if (!(d > 0) || d > 7.6) return e('Видео длиннее 7 секунд');
    }

    e('Загружаю на сервер…');
    const u = URL.createObjectURL(af), a = new Audio(u);
    await new Promise(r => { a.onloadedmetadata = r; a.onerror = r; setTimeout(r, 4000); });
    const dur = isFinite(a.duration) ? a.duration : 0;
    URL.revokeObjectURL(u);

    let title = n, artist = $('#sp').value.trim() || me.nick, lyrics = $('#sl').value.trim(), lrc = '', coverFile = cf || null;
    if (S.auto && (!lyrics || !coverFile)) {
      const info = await findInfo(title, $('#sp').value.trim(), !lyrics, !coverFile);
      if (info.lyrics && !lyrics) { lyrics = info.lyrics; lrc = info.lrc || ''; }
      if (info.cover && !coverFile) coverFile = info.cover;
      if (info.artist && !$('#sp').value.trim()) artist = info.artist;
    }

    const kd = ukind(me) === 'both'
      ? (($('#sk2 .on') || { dataset: {} }).dataset.sk || 'own')
      : ukind(me) === 'artist' ? 'own' : 'web';

    const fd = new FormData();
    fd.append('title', title);
    fd.append('owner', me.key);
    fd.append('artist', artist);
    fd.append('perf', !!$('#sp').value.trim());
    fd.append('lyrics', lyrics);
    fd.append('lrc', lrc);
    fd.append('kind', kd);
    fd.append('hue', Math.random() * 360 | 0);
    fd.append('dur', dur);
    fd.append('audio', af);
    if (coverFile) fd.append('cover', coverFile, 'cover.jpg');
    if (vf) fd.append('video', vf);

    const res = await fetch(`${API}/songs`, { method: 'POST', body: fd });
    if (!res.ok) return e('Ошибка загрузки на сервер');

    closeModal();
    await syncFromServer();
    toast('Песня опубликована');
  };

  // Редактирование и удаление песни
  saveTrack = async function () {
    const e = m => { $('#se').textContent = m; };
    const t = tr(EDT);
    if (!t || !canDel(t)) return;
    const n = $('#tn').value.trim(), cf = $('#tcf').files[0], ar = $('#ta') ? $('#ta').value.trim() : t.artist;
    if (!n) return e('Введите название');

    const fd = new FormData();
    fd.append('title', n);
    if (ar) fd.append('artist', ar);
    if ($('#tl')) fd.append('lyrics', $('#tl').value.trim());
    if (cf) fd.append('cover', cf);

    const res = await fetch(`${API}/songs/${t.id}`, { method: 'PUT', body: fd });
    if (!res.ok) return e('Не удалось сохранить');

    closeModal();
    await syncFromServer();
    sync();
    toast('Сохранено');
  };

  delTrack = async function (id) {
    const t = tr(id);
    if (!t || !canDel(t) || !confirm('Удалить «' + t.title + '»?')) return;
    await fetch(`${API}/songs/${id}`, { method: 'DELETE' });
    if (cur && cur.id === id) resetPlayer();
    await syncFromServer();
    toast('Песня удалена');
  };

  // Плейлисты
  savePlaylist = async function () {
    const e = m => { $('#se').textContent = m; };
    const n = $('#fn').value.trim(), cf = $('#fc').files[0], { id, tid } = EDT || {};
    if (!n) return e('Введите название');

    const fd = new FormData();
    fd.append('n', n);
    if ($('#fd')) fd.append('desc', $('#fd').value.trim());
    if (cf) fd.append('cover', cf);

    if (id) {
      await fetch(`${API}/playlists/${id}`, { method: 'PUT', body: fd });
    } else {
      fd.append('owner', me.key);
      fd.append('ownerNick', me.nick);
      fd.append('h', Math.random() * 360 | 0);
      fd.append('ids', JSON.stringify(tid ? [tid] : []));
      await fetch(`${API}/playlists`, { method: 'POST', body: fd });
    }
    closeModal();
    await syncFromServer();
    toast(id ? 'Плейлист обновлён' : 'Плейлист создан');
  };

  delPl = async function (id) {
    const p = PL.find(x => x.id === id);
    if (!p || !canEditPl(p) || !confirm('Удалить плейлист «' + p.n + '»?')) return;
    await fetch(`${API}/playlists/${id}`, { method: 'DELETE' });
    await syncFromServer();
    nav(V === 'pl' ? 'library' : V);
    toast('Плейлист удалён');
  };

  addToPl = async function (pid, tid) {
    const p = PL.find(x => x.id === pid);
    if (!p) return;
    if (p.ids.includes(tid)) { closeModal(); return toast('Уже в плейлисте'); }
    const nextIds = [...p.ids, tid];
    const fd = new FormData();
    fd.append('ids', JSON.stringify(nextIds));
    await fetch(`${API}/playlists/${pid}`, { method: 'PUT', body: fd });
    closeModal();
    await syncFromServer();
    toast('Добавлено в «' + p.n + '»');
  };

  rmFromPl = async function (tid, pid) {
    const p = PL.find(x => x.id === pid);
    if (!p) return;
    const nextIds = p.ids.filter(i => i !== tid);
    const fd = new FormData();
    fd.append('ids', JSON.stringify(nextIds));
    await fetch(`${API}/playlists/${pid}`, { method: 'PUT', body: fd });
    await syncFromServer();
    toast('Убрано из плейлиста');
  };

  // Профили и настройки приватности
  saveProf = async function () {
    const e = m => { $('#se').textContent = m; };
    const key = EDT, nick = $('#un').value.trim(), cf = $('#uc').files[0], bf = $('#ub').files[0];
    const fd = new FormData();
    if (key !== ADMIN.key) fd.append('nick', nick);
    fd.append('kind', $('#uk').value);
    fd.append('bio', ($('#ubio')?.value || '').trim().slice(0, 180));
    if ($('#upr')) fd.append('privateProfile', $('#upr').checked);
    if ($('#uem')) fd.append('showEmail', $('#uem').checked);
    if (cf) fd.append('avatar', cf);
    if (bf) fd.append('banner', bf);

    const res = await fetch(`${API}/users/${key}`, { method: 'PUT', body: fd });
    const data = await res.json();
    if (!res.ok) return e(data.error || 'Не удалось сохранить');

    closeModal();
    await syncFromServer();
    toast('Профиль обновлён');
  };

  pkDone = async function () {
    if (PK.size < 5 || !me) return;
    FA = [...PK];
    await fetch(`${API}/users/${me.key}/fav-artists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artists: FA })
    });
    const el = $('#pick');
    el.hidden = true;
    side();
    nav('home');
    toast('Любимые артисты сохранены');
  };

  // Социальные реакции
  like = function (id) {
    if (!tr(id) || !me) return;
    if (liked.has(id)) liked.delete(id); else { liked.add(id); dis.delete(id); }
    markLikes(); sync();
    fetch(`${API}/songs/${id}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userKey: me.key })
    }).then(() => syncFromServer());
  };

  toggleSaved = function (id) {
    if (!me) return toast('Войди в аккаунт');
    if (savedTracks.has(id)) savedTracks.delete(id); else savedTracks.add(id);
    fetch(`${API}/songs/${id}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userKey: me.key })
    }).then(() => syncFromServer());
    toast(savedTracks.has(id) ? 'Добавлено в избранное' : 'Удалено из избранного');
  };

  const origBumpView = bumpView;
  bumpView = function (id) {
    origBumpView(id);
    fetch(`${API}/songs/${id}/view`, { method: 'POST' }).catch(() => {});
  };

  postComment = async function () {
    if (!me || !CMID) return;
    const text = ($('#commentText')?.value || '').trim();
    if (!text) return toast('Напиши текст комментария');
    const res = await fetch(`${API}/songs/${CMID}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: me.key, nick: me.nick, text })
    });
    if (res.ok) {
      await syncFromServer();
      commentModal(CMID);
      toast('Комментарий опубликован');
    }
  };

  deleteComment = async function (cid) {
    if (!me || !CMID) return;
    await fetch(`${API}/songs/${CMID}/comments/${cid}`, { method: 'DELETE' });
    await syncFromServer();
    commentModal(CMID);
    toast('Комментарий удалён');
  };

  toggleFollow = async function (key) {
    if (!me || key === me.key) return;
    await fetch(`${API}/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: me.key, to: key })
    });
    await syncFromServer();
  };

  // Модерация артистов и пользователей
  saveArtistCover = async function (name) {
    if (!isAdmin()) return;
    const f = $('#artistCoverFile')?.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('name', name);
    fd.append('cover', f);
    await fetch(`${API}/artists/cover`, { method: 'POST', body: fd });
    closeModal();
    await syncFromServer();
    refreshAp(name);
    toast('Обложка артиста обновлена');
  };

  resetArtistCover = async function (name) {
    if (!isAdmin()) return;
    await fetch(`${API}/artists/cover/${encodeURIComponent(name)}`, { method: 'DELETE' });
    delete PH[name];
    closeModal();
    await syncFromServer();
    refreshAp(name);
    toast('Автопоиск обложки включён');
  };

  delArtist = async function (name) {
    if (!isAdmin() || !confirm('Удалить артиста «' + name + '» у всех пользователей?')) return;
    await fetch(`${API}/artists/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', name })
    });
    await syncFromServer();
    toast('Артист удалён');
  };

  restoreArtist = async function (name) {
    if (!isAdmin()) return;
    await fetch(`${API}/artists/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restore', name })
    });
    await syncFromServer();
    toast('Артист возвращён');
  };

  addArtist = async function () {
    if (!isAdmin()) return;
    const n = ($('#aan')?.value || '').trim();
    if (n.length < 2) return toast('Введите имя артиста');
    await fetch(`${API}/artists/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', name: n })
    });
    await syncFromServer();
    toast('Артист добавлен');
  };

  toggleBan = async function (key) {
    if (!isAdmin() || key === ADMIN.key) return;
    await fetch(`${API}/admin/ban/${key}`, { method: 'POST' });
    await syncFromServer();
    toast('Статус блокировки обновлён');
  };

  delUser = async function (key) {
    if (!isAdmin() || key === ADMIN.key || !confirm('Удалить аккаунт?')) return;
    await fetch(`${API}/admin/users/${key}`, { method: 'DELETE' });
    await syncFromServer();
    toast('Аккаунт удалён');
  };

  // Инициализация сессии при перезагрузке страницы
  setTimeout(async () => {
    await syncFromServer();
    const savedKey = localStorage.zenithSession;
    if (savedKey && !me) {
      const found = [ADMIN, ...UL].find(u => u.key === savedKey);
      if (found && !found.banned) {
        setMe(found);
        await syncFromServer();
      }
    }
  }, 200);

  if (location.protocol === 'file:' && !BASE_URL) {
    setTimeout(() => {
      const url = prompt('Укажи адрес твоего сервера ZENITH (например: https://zenith-server.onrender.com):');
      if (url && url.startsWith('http')) {
        localStorage.setItem('zenithServerUrl', url.trim().replace(/\/+$/, ''));
        location.reload();
      }
    }, 800);
  }

})();
