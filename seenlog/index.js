(function (vd) {
  "use strict";
  /*
 * Seen & Log — кто когда был, что удалили и что поправили.
 *
 * Честно про границы: Discord не отдаёт историю задним числом. Плагин
 * знает только то, что видел сам, пока телефон был онлайн, — с момента
 * установки база наполняется постепенно. Статусы приходят по друзьям и
 * общим серверам, удаления и правки ловятся только у прочитанных каналов.
 *
 * Файл начинается сразу с кода: загрузчик оборачивает его в
 * `vendetta => { return <файл> }`, а комментарий с переносом строки
 * превратил бы return в return; — и плагин не загрузился бы.
 */

  if (!vd || !vd.metro || !vd.metro.common) {
    return { onLoad: function () {}, onUnload: function () {} };
  }

  var React = vd.metro.common.React;
  var RN = vd.metro.common.ReactNative;
  var clipboard = vd.metro.common.clipboard || {};
  var Flux = vd.metro.common.FluxDispatcher;
  var showToast = (vd.ui && vd.ui.toasts && vd.ui.toasts.showToast) || null;
  var getAssetIDByName = (vd.ui && vd.ui.assets && vd.ui.assets.getAssetIDByName) || null;
  var ErrorBoundary = (vd.ui && vd.ui.components && vd.ui.components.ErrorBoundary) || null;
  var useProxy = (vd.storage && vd.storage.useProxy) || function () {};

  function toast(msg, icon) {
    try {
      if (showToast) {
        showToast(msg, getAssetIDByName ? getAssetIDByName(icon || "ic_info_24px") : undefined);
        return;
      }
      alert(msg);
    } catch (e) {}
  }

  // ------------------------------------------------------------- хранилище

  var storage = (vd.plugin && vd.plugin.storage) || null;
  var VOLATILE = false;
  if (!storage) { storage = {}; VOLATILE = true; }

  var STYLES = [
    ["marker", "только пометка"],
    ["strike", "зачёркнутый"],
    ["ansi", "цветной блок"],
    ["diff", "красный diff"]
  ];

  var ANSI = [
    ["31", "красный"], ["33", "жёлтый"], ["32", "зелёный"],
    ["36", "голубой"], ["35", "розовый"], ["34", "синий"], ["30", "серый"]
  ];

  var DEFAULTS = {
    // логгер
    keepDeleted: true,        // оставлять удалённое в чате
    showEdits: true,          // показывать прошлую версию под правкой
    style: "ansi",
    ansiColor: "31",
    markerDel: "🗑",
    markerEdit: "✏️",
    ignoreSelf: false,        // не трогать свои же сообщения
    notifyFallback: true,     // если переписать сообщение не вышло — сказать себе
    // кто когда
    trackPresence: true,
    trackMessages: true,
    // общее
    logLimit: 300,
    seen: {},                 // id → { name, msg, online, status }
    log: []                   // последние удаления и правки
  };

  function get(key) {
    var v = storage[key];
    return (v === undefined || v === null) ? DEFAULTS[key] : v;
  }
  function set(key, value) { storage[key] = value; }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  function initStorage() {
    for (var k in DEFAULTS) {
      if (storage[k] === undefined || storage[k] === null) {
        storage[k] = typeof DEFAULTS[k] === "object" ? copy(DEFAULTS[k]) : DEFAULTS[k];
      }
    }
  }

  // Запись идёт в память, на диск сбрасывается пачкой: в активном сервере
  // события сыплются десятками в секунду, и писать каждое было бы дорого.
  var mem = { seen: null, log: null, dirty: false };
  var flushTimer = null;

  function seenMap() {
    if (!mem.seen) mem.seen = copy(get("seen") || {});
    return mem.seen;
  }
  function logList() {
    if (!mem.log) mem.log = copy(get("log") || []);
    return mem.log;
  }
  function touch() {
    mem.dirty = true;
  }
  function flush(force) {
    if (!mem.dirty && !force) return;
    mem.dirty = false;
    try {
      if (mem.seen) set("seen", mem.seen);
      if (mem.log) set("log", mem.log.slice(-get("logLimit")));
    } catch (e) {}
  }

  // ------------------------------------------------------------- хранилки

  var _stores = null;
  function stores() {
    if (!_stores) {
      _stores = {};
      try { _stores.msg = vd.metro.findByStoreName("MessageStore"); } catch (e) {}
      try { _stores.user = vd.metro.findByStoreName("UserStore"); } catch (e) {}
      try { _stores.channel = vd.metro.findByStoreName("ChannelStore"); } catch (e) {}
      try { _stores.clyde = vd.metro.findByProps("sendBotMessage"); } catch (e) {}
    }
    return _stores;
  }

  function myId() {
    try {
      var u = stores().user.getCurrentUser();
      return u ? u.id : null;
    } catch (e) { return null; }
  }

  function userName(id) {
    var s = seenMap()[id];
    if (s && s.name) return s.name;
    try {
      var u = stores().user.getUser(id);
      if (u) return u.globalName || u.username;
    } catch (e) {}
    return id;
  }

  function ago(ts) {
    if (!ts) return "не видел";
    var d = Math.max(0, Date.now() - ts);
    var m = Math.floor(d / 60000);
    if (m < 1) return "только что";
    if (m < 60) return m + " мин назад";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " ч назад";
    var days = Math.floor(h / 24);
    if (days < 30) return days + " дн назад";
    return new Date(ts).toLocaleDateString();
  }

  function clock(ts) {
    try {
      var d = new Date(ts);
      return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    } catch (e) { return ""; }
  }

  // -------------------------------------------------------------- события

  function noteMessage(msg) {
    if (!get("trackMessages") || !msg || !msg.author || msg.author.bot) return;
    var id = msg.author.id;
    if (id === myId()) return;
    var m = seenMap();
    var rec = m[id] || {};
    rec.name = msg.author.globalName || msg.author.username || rec.name;
    rec.msg = Date.now();
    rec.channel = msg.channel_id || msg.channelId || rec.channel;
    m[id] = rec;
    touch();
  }

  function notePresence(update) {
    if (!get("trackPresence") || !update) return;
    var u = update.user || {};
    if (!u.id || u.id === myId()) return;
    var m = seenMap();
    var rec = m[u.id] || {};
    if (u.username) rec.name = u.globalName || u.username;
    var status = update.status || "offline";
    // «был в сети» — это момент ухода в offline либо любая активность
    if (status !== "offline") rec.online = Date.now();
    else if (rec.status && rec.status !== "offline") rec.online = Date.now();
    rec.status = status;
    m[u.id] = rec;
    touch();
  }

  function record(kind, entry) {
    var l = logList();
    l.push(entry);
    if (l.length > get("logLimit") + 50) mem.log = l.slice(-get("logLimit"));
    touch();
  }

  function decorate(text, kind) {
    var marker = kind === "edit" ? get("markerEdit") : get("markerDel");
    var body = String(text || "");
    var style = get("style");
    if (style === "strike") return marker + " ~~" + body.replace(/\n/g, " ") + "~~";
    if (style === "diff") {
      return marker + "\n```diff\n" +
        body.split("\n").map(function (l) { return "- " + l; }).join("\n") + "\n```";
    }
    if (style === "ansi") {
      return marker + "\n```ansi\n\u001b[" + get("ansiColor") + "m" + body + "\n```";
    }
    return marker + " " + body;
  }

  function plainCopy(m, channelId, content) {
    // MESSAGE_UPDATE ждёт сырое сообщение, а не Record из стора
    return {
      id: m.id,
      channel_id: channelId || m.channel_id || m.channelId,
      guild_id: m.guild_id || m.guildId,
      author: m.author,
      content: content,
      timestamp: m.timestamp,
      edited_timestamp: m.editedTimestamp || m.edited_timestamp || null,
      type: m.type,
      flags: m.flags,
      pinned: !!m.pinned,
      mentions: [],
      mention_roles: [],
      attachments: m.attachments || [],
      embeds: m.embeds || []
    };
  }

  function fallbackTell(channelId, text) {
    if (!get("notifyFallback")) return;
    var s = stores();
    try {
      if (s.clyde && s.clyde.sendBotMessage) s.clyde.sendBotMessage(channelId, text);
    } catch (e) {}
  }

  function onDelete(event) {
    var s = stores();
    var m = null;
    try { m = s.msg && s.msg.getMessage(event.channelId, event.id); } catch (e) {}
    if (!m || !m.author) return false;
    if (get("ignoreSelf") && m.author.id === myId()) return false;
    var content = String(m.content || "");
    if (!content && m.attachments && m.attachments.length) content = "[вложение]";
    if (!content) return false;

    record("del", {
      kind: "del", ts: Date.now(), channelId: event.channelId,
      authorId: m.author.id, name: m.author.globalName || m.author.username,
      text: content
    });

    if (!get("keepDeleted")) return false;
    try {
      event.type = "MESSAGE_UPDATE";
      event.message = plainCopy(m, event.channelId, decorate(content, "del"));
      return true;                    // удаление превратилось в правку
    } catch (e) {
      fallbackTell(event.channelId,
        get("markerDel") + " удалено: " + content.slice(0, 400));
      return false;
    }
  }

  function onEdit(event) {
    var msg = event.message;
    if (!msg || !msg.id || msg.content === undefined) return;
    var s = stores();
    var old = null;
    try { old = s.msg && s.msg.getMessage(msg.channel_id || event.channelId, msg.id); } catch (e) {}
    if (!old || !old.content) return;
    var before = String(old.content);
    var after = String(msg.content);
    if (before === after) return;
    if (before.indexOf(get("markerDel")) === 0) return;      // наша же подстановка
    var author = msg.author || old.author || {};
    if (get("ignoreSelf") && author.id === myId()) return;

    record("edit", {
      kind: "edit", ts: Date.now(), channelId: msg.channel_id || event.channelId,
      authorId: author.id, name: author.globalName || author.username,
      text: after, before: before
    });

    if (!get("showEdits")) return;
    try {
      msg.content = after + "\n-# " + get("markerEdit") + " было: " +
        before.replace(/\n/g, " ").slice(0, 300);
    } catch (e) {}
  }

  // =================================================================== UI

  var COLORS = {
    text: "#f2f3f5", dim: "#a3a6aa", card: "rgba(255,255,255,0.06)",
    line: "rgba(255,255,255,0.12)", accent: "#a98be0", bad: "#e5707f",
    input: "rgba(0,0,0,0.28)"
  };
  var el = React.createElement;

  function Dim(text, size) {
    return el(RN.Text, { style: { color: COLORS.dim, fontSize: size || 12, marginTop: 2 } },
              text);
  }
  function Section(title, children) {
    return el(RN.View, { style: {
      backgroundColor: COLORS.card, borderRadius: 14, padding: 14,
      marginHorizontal: 12, marginTop: 12
    } }, [
      el(RN.Text, { key: "t", style: {
        color: COLORS.accent, fontSize: 13, fontWeight: "700",
        letterSpacing: 0.6, marginBottom: 10, textTransform: "uppercase"
      } }, title)
    ].concat(children));
  }
  function Row(children, extra) {
    return el(RN.View, { style: Object.assign({
      flexDirection: "row", alignItems: "center", flexWrap: "wrap"
    }, extra || {}) }, children);
  }
  function Chip(label, active, onPress, key) {
    return el(RN.TouchableOpacity, {
      key: key || label, onPress: onPress,
      style: {
        paddingVertical: 7, paddingHorizontal: 13, borderRadius: 10, marginRight: 7,
        marginBottom: 7, borderWidth: 1,
        borderColor: active ? COLORS.accent : COLORS.line,
        backgroundColor: active ? "rgba(169,139,224,0.22)" : "transparent"
      }
    }, el(RN.Text, { style: {
      color: active ? COLORS.accent : COLORS.text, fontSize: 13,
      fontWeight: active ? "700" : "500"
    } }, label));
  }
  function Button(label, onPress, kind, key) {
    var primary = kind === "primary";
    return el(RN.TouchableOpacity, {
      key: key || label, onPress: onPress,
      style: {
        paddingVertical: 10, paddingHorizontal: 15, borderRadius: 10, marginRight: 8,
        marginTop: 8, borderWidth: primary ? 0 : 1, borderColor: COLORS.line,
        backgroundColor: primary ? COLORS.accent : "transparent"
      }
    }, el(RN.Text, { style: {
      color: primary ? "#1b1226" : COLORS.text, fontWeight: "700", fontSize: 13
    } }, label));
  }
  function Input(props) {
    return el(RN.TextInput, Object.assign({
      placeholderTextColor: COLORS.dim,
      style: {
        color: COLORS.text, backgroundColor: COLORS.input, borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, marginTop: 6,
        borderWidth: 1, borderColor: COLORS.line
      }
    }, props));
  }
  function Toggle(label, value, onChange, key) {
    return el(RN.View, {
      key: key || label,
      style: { flexDirection: "row", alignItems: "center",
               justifyContent: "space-between", marginTop: 10 }
    }, [
      el(RN.Text, { key: "l", style: { color: COLORS.text, fontSize: 14, flex: 1 } }, label),
      el(RN.Switch, { key: "s", value: !!value, onValueChange: onChange,
                      trackColor: { true: COLORS.accent } })
    ]);
  }

  var STATUS_DOT = { online: "🟢", idle: "🌙", dnd: "⛔", offline: "⚫" };

  function SettingsPage() {
    useProxy(storage);
    var st = React.useState({ tab: "seen", q: "", filter: "all" });
    var state = st[0], setState = st[1];
    function patch(o) { setState(Object.assign({}, state, o)); }

    var tabs = [["seen", "Кто когда"], ["log", "Лог"], ["opts", "Настройки"]];
    var body = [];

    if (state.tab === "seen") {
      var map = seenMap();
      var ids = Object.keys(map).sort(function (a, b) {
        return Math.max(map[b].msg || 0, map[b].online || 0) -
               Math.max(map[a].msg || 0, map[a].online || 0);
      });
      var q = state.q.toLowerCase();
      if (q) {
        ids = ids.filter(function (id) {
          return String(map[id].name || id).toLowerCase().indexOf(q) >= 0;
        });
      }
      body.push(Section("Поиск", [
        Input({ key: "q", value: state.q, placeholder: "имя…",
                onChangeText: function (v) { patch({ q: v }); } }),
        Dim("Записей: " + Object.keys(map).length +
            ". База наполняется, пока ты в сети — истории до установки нет.")
      ]));
      body.push(Section("Последняя активность", ids.length ? ids.slice(0, 80).map(function (id) {
        var r = map[id];
        return el(RN.View, { key: id, style: {
          paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: COLORS.line
        } }, [
          el(RN.Text, { key: "n", style: { color: COLORS.text, fontSize: 14 } },
            (STATUS_DOT[r.status] || "⚫") + " " + (r.name || id)),
          el(RN.Text, { key: "d", style: { color: COLORS.dim, fontSize: 12 } },
            "написал: " + ago(r.msg) + "   ·   в сети: " + ago(r.online))
        ]);
      }) : [Dim("пока пусто")]));
    }

    if (state.tab === "log") {
      var list = logList().slice().reverse();
      if (state.filter !== "all") {
        list = list.filter(function (e) { return e.kind === state.filter; });
      }
      body.push(Section("Фильтр", [
        Row([
          Chip("всё", state.filter === "all", function () { patch({ filter: "all" }); }, "f0"),
          Chip("удалённые", state.filter === "del", function () { patch({ filter: "del" }); }, "f1"),
          Chip("правки", state.filter === "edit", function () { patch({ filter: "edit" }); }, "f2")
        ], { key: "f" }),
        Row([
          Button("копировать лог", function () {
            try {
              clipboard.setString(list.map(function (e) {
                return clock(e.ts) + " " + e.name + ": " + e.text;
              }).join("\n"));
              toast("лог в буфере", "ic_check_24px");
            } catch (e) { toast("буфер недоступен"); }
          }, "", "cp"),
          Button("очистить", function () {
            mem.log = [];
            flush(true);
            toast("лог пуст", "ic_check_24px");
          }, "", "cl")
        ], { key: "b" })
      ]));
      body.push(Section("Записей: " + list.length, list.length
        ? list.slice(0, 120).map(function (e, i) {
          return el(RN.View, { key: i, style: {
            paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: COLORS.line
          } }, [
            el(RN.Text, { key: "h", style: { color: COLORS.text, fontSize: 13 } },
              (e.kind === "del" ? get("markerDel") : get("markerEdit")) + " " +
              (e.name || e.authorId) + "  ·  " + clock(e.ts)),
            el(RN.Text, { key: "t", style: { color: COLORS.dim, fontSize: 13 } },
              e.kind === "edit" ? ("было: " + e.before + "\nстало: " + e.text) : e.text)
          ]);
        }) : [Dim("пока пусто")]));
    }

    if (state.tab === "opts") {
      body.push(Section("В чате", [
        Toggle("оставлять удалённые сообщения", get("keepDeleted"),
               function (v) { set("keepDeleted", v); }, "kd"),
        Toggle("показывать прошлую версию под правкой", get("showEdits"),
               function (v) { set("showEdits", v); }, "se"),
        Toggle("не трогать мои собственные сообщения", get("ignoreSelf"),
               function (v) { set("ignoreSelf", v); }, "is"),
        Toggle("если переписать не вышло — сказать отдельным сообщением",
               get("notifyFallback"), function (v) { set("notifyFallback", v); }, "nf")
      ]));
      body.push(Section("Как выглядит удалённое", [
        Row(STYLES.map(function (s) {
          return Chip(s[1], get("style") === s[0],
                      function () { set("style", s[0]); }, s[0]);
        }), { key: "st" }),
        get("style") === "ansi" ? el(RN.View, { key: "c" }, [
          Dim("цвет"),
          Row(ANSI.map(function (c) {
            return Chip(c[1], get("ansiColor") === c[0],
                        function () { set("ansiColor", c[0]); }, c[0]);
          }))
        ]) : null,
        el(RN.View, { key: "mk", style: { marginTop: 8 } }, [
          Dim("пометка удалённого"),
          Input({ key: "d", value: get("markerDel"),
                  onChangeText: function (v) { set("markerDel", v); } }),
          Dim("пометка правки"),
          Input({ key: "e", value: get("markerEdit"),
                  onChangeText: function (v) { set("markerEdit", v); } })
        ]),
        el(RN.View, { key: "prev", style: {
          marginTop: 12, padding: 10, borderRadius: 10, backgroundColor: COLORS.input
        } }, [
          Dim("как это будет выглядеть"),
          el(RN.Text, { key: "p", style: {
            color: COLORS.text, fontSize: 13, marginTop: 4
          } }, decorate("ладно, забей", "del"))
        ]),
        Dim("Цвет в тексте сообщения Discord на телефоне даёт только через " +
            "блок кода: варианты «цветной блок» и «diff» рисуют его именно так. " +
            "Если в твоей сборке подсветка блоков не работает, бери пометку или " +
            "зачёркивание — они отображаются везде.")
      ]));
      body.push(Section("Слежение", [
        Toggle("запоминать, когда человек писал", get("trackMessages"),
               function (v) { set("trackMessages", v); }, "tm"),
        Toggle("запоминать статусы онлайна", get("trackPresence"),
               function (v) { set("trackPresence", v); }, "tp"),
        Row([
          Button("сбросить историю активности", function () {
            mem.seen = {};
            flush(true);
            toast("очищено", "ic_check_24px");
          }, "", "cs"),
          Button("сброс настроек", function () {
            for (var k in DEFAULTS) {
              set(k, typeof DEFAULTS[k] === "object" ? copy(DEFAULTS[k]) : DEFAULTS[k]);
            }
            mem.seen = null; mem.log = null;
            toast("сброшено", "ic_check_24px");
          }, "", "rs")
        ], { key: "b" }),
        VOLATILE ? el(RN.Text, { key: "w", style: {
          color: COLORS.bad, fontSize: 12, marginTop: 8
        } }, "Мод не отдал хранилище плагина — записи живут до перезапуска.")
          : Dim("Статусы приходят только по друзьям и общим серверам, " +
                "удаления и правки — только по открытым каналам и только пока " +
                "клиент запущен.")
      ]));
    }

    var page = el(RN.ScrollView, { style: { flex: 1 } }, [
      el(RN.View, { key: "tabs", style: {
        flexDirection: "row", paddingHorizontal: 12, paddingTop: 12
      } }, tabs.map(function (t) {
        return Chip(t[1], state.tab === t[0], function () { patch({ tab: t[0] }); }, t[0]);
      })),
      el(RN.View, { key: "body" }, body),
      el(RN.View, { key: "pad", style: { height: 40 } })
    ]);
    return ErrorBoundary ? el(ErrorBoundary, null, page) : page;
  }

  // ============================================================== плагин

  var undo = [];

  function argOf(args, name) {
    for (var i = 0; i < (args || []).length; i++) {
      if (args[i].name === name) return args[i].value;
    }
  }
  function tell(ctx, text) {
    var s = stores();
    try {
      if (s.clyde && s.clyde.sendBotMessage && ctx && ctx.channel) {
        s.clyde.sendBotMessage(ctx.channel.id, text);
        return;
      }
    } catch (e) {}
    toast(String(text).slice(0, 120));
  }

  return {
    settings: SettingsPage,

    onLoad: function () {
      initStorage();

      // один перехват на всё: события идут через диспетчер, и ловить их
      // здесь дешевле, чем вешать отдельные подписки
      try {
        undo.push(vd.patcher.before("dispatch", Flux, function (args) {
          var e = args && args[0];
          if (!e || !e.type) return;
          try {
            if (e.type === "MESSAGE_CREATE") noteMessage(e.message);
            else if (e.type === "MESSAGE_DELETE") onDelete(e);
            else if (e.type === "MESSAGE_UPDATE") onEdit(e);
            else if (e.type === "PRESENCE_UPDATES") {
              var ups = e.updates || [];
              for (var i = 0; i < ups.length; i++) notePresence(ups[i]);
            } else if (e.type === "PRESENCE_UPDATE") notePresence(e);
          } catch (err) {}
        }));
      } catch (e) {
        toast("Seen & Log: не вышло перехватить события");
      }

      flushTimer = setInterval(function () { flush(false); }, 20000);

      var reg = vd.commands && vd.commands.registerCommand;
      if (!reg) return;

      undo.push(reg({
        name: "lastseen", displayName: "lastseen",
        description: "Когда человек последний раз писал и был в сети",
        displayDescription: "Когда человек последний раз писал и был в сети",
        type: 1, inputType: 0, applicationId: "-1",
        options: [{ name: "user", displayName: "user", description: "кто",
                    displayDescription: "кто", type: 6, required: true }],
        execute: function (args, ctx) {
          var id = argOf(args, "user");
          var r = seenMap()[id];
          if (!r) {
            tell(ctx, "Про " + userName(id) + " записей пока нет — плагин видит " +
                      "только то, что происходило после установки.");
            return;
          }
          tell(ctx,
            (STATUS_DOT[r.status] || "⚫") + " " + (r.name || userName(id)) + "\n" +
            "последнее сообщение: " + ago(r.msg) + "\n" +
            "был в сети: " + ago(r.online) +
            (r.status ? "  (сейчас " + r.status + ")" : ""));
        }
      }));

      undo.push(reg({
        name: "msglog", displayName: "msglog",
        description: "Последние удалённые и изменённые сообщения",
        displayDescription: "Последние удалённые и изменённые сообщения",
        type: 1, inputType: 0, applicationId: "-1",
        options: [{ name: "count", displayName: "count", description: "сколько",
                    displayDescription: "сколько", type: 4, required: false }],
        execute: function (args, ctx) {
          var n = argOf(args, "count") || 10;
          var here = ctx && ctx.channel ? ctx.channel.id : null;
          var list = logList().filter(function (e) {
            return !here || e.channelId === here;
          }).slice(-n).reverse();
          if (!list.length) { tell(ctx, "в этом канале пока ничего не ловилось"); return; }
          tell(ctx, list.map(function (e) {
            return (e.kind === "del" ? get("markerDel") : get("markerEdit")) + " " +
              clock(e.ts) + " " + (e.name || "?") + ": " +
              (e.kind === "edit" ? e.before + " → " + e.text : e.text);
          }).join("\n").slice(0, 1800));
        }
      }));
    },

    onUnload: function () {
      flush(true);
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      for (var i = 0; i < undo.length; i++) {
        try { undo[i](); } catch (e) {}
      }
      undo = [];
    }
  };
})(typeof vendetta !== "undefined" && vendetta
   ? vendetta
   : (globalThis.vendetta || globalThis.bunny || globalThis.kettu || globalThis.revenge))
