/* 精读 · 查经 —— 纯前端，零依赖，可离线运行
 * v2：数据按「章」切片，边下边渲染，空闲预热索引
 */
(function () {
  "use strict";

  var DATA_V = "v2";                 // 数据目录版本，改数据时同步改这里
  var BOOKS = [];
  var chapCache = {};                // "b:c" -> 章节对象
  var chapPending = {};              // "b:c" -> {promise, resolve, reject}
  var aliasMap = null;

  var state = {
    view: "ask",
    book: 40, chap: 5, verse: 1,
    lex: null, conc: null, search: null,
    loading: {}
  };

  /* 章节文件回调：并发安全 */
  window.__chp = function (key, data) {
    chapCache[key] = data;
    var p = chapPending[key];
    if (p) { delete chapPending[key]; p.resolve(data); }
  };

  var $ = function (id) { return document.getElementById(id); };
  var askView, readView, readerEl, panelEl, askResult, qInput, bookSel, chapSel;

  /* ---------------- 基础 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function pad3(n) { return n < 100 ? (n < 10 ? "00" + n : "0" + n) : "" + n; }
  function bookMeta(n) {
    for (var i = 0; i < BOOKS.length; i++) if (BOOKS[i].n === n) return BOOKS[i];
    return null;
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("无法载入 " + src)); };
      document.head.appendChild(s);
    });
  }
  function chapterOf(b, c) { return chapCache[b + ":" + c] || null; }

  function loadChapter(b, c) {
    var key = b + ":" + c;
    if (chapCache[key]) return Promise.resolve(chapCache[key]);
    if (chapPending[key]) return chapPending[key].promise;

    var resolve, reject;
    var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    chapPending[key] = { promise: promise, resolve: resolve, reject: reject };

    var el = document.createElement("script");
    el.src = "data/" + DATA_V + "/ch" + pad2(b) + "-" + pad3(c) + ".js";
    el.onerror = function () {
      delete chapPending[key];
      reject(new Error("无法载入 " + key));
    };
    document.head.appendChild(el);
    return promise;
  }

  /* ---------------- 索引加载 ---------------- */
  function ensureLex() {
    if (state.lex) return Promise.resolve(state.lex);
    if (state.loading.lex) return state.loading.lex;
    var prev = window.__LEX; window.__LEX = null;
    state.loading.lex = loadScript("data/" + DATA_V + "/lex.js").then(function () {
      state.lex = window.__LEX || {}; window.__LEX = prev; return state.lex;
    });
    return state.loading.lex;
  }

  function ensureConc() {
    if (state.conc) return Promise.resolve(state.conc);
    if (state.loading.conc) return state.loading.conc;
    var prev = window.__CONC; window.__CONC = null;
    state.loading.conc = loadScript("data/" + DATA_V + "/conc.js").then(function () {
      state.conc = window.__CONC || {}; window.__CONC = prev; return state.conc;
    });
    return state.loading.conc;
  }

  function ensureSearch() {
    if (state.search) return Promise.resolve(state.search);
    if (state.loading.search) return state.loading.search;
    var prev = window.__SEARCH; window.__SEARCH = null;
    state.loading.search = loadScript("data/" + DATA_V + "/search.js").then(function () {
      var raw = window.__SEARCH; window.__SEARCH = prev;
      var digits = "0123456789abcdefghijklmnopqrstuvwxyz";
      var parts = raw.r.split(",");
      var refs = new Array(parts.length);
      for (var i = 0; i < parts.length; i++) {
        var n = 0, s = parts[i];
        for (var j = 0; j < s.length; j++) n = n * 36 + digits.indexOf(s[j]);
        refs[i] = n;
      }
      state.search = { texts: raw.t.split("\u0001"), refs: refs, all: null };
      return state.search;
    });
    return state.loading.search;
  }

  /* 空闲时预热：让第一次点击「查」不再空等 */
  function warmup() {
    var c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ""))) return;
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1200); };
    idle(function () {
      ensureLex().catch(function () {});
      ensureConc().catch(function () {});
    }, { timeout: 3000 });
    setTimeout(function () { ensureSearch().catch(function () {}); }, 1800);
  }

  /* ---------------- 书卷别名 ---------------- */
  function buildAliasMap() {
    var map = {};
    BOOKS.forEach(function (b) {
      var cands = [b.name, b.abbr, b.name.replace(/(福音|书|记|上|下|前书|后书)$/g, ""), b.name.replace(/[上下]?书?$/g, "")];
      if (b.name.length >= 3) cands.push(b.name.slice(0, 2));
      cands.forEach(function (c) {
        c = (c || "").trim();
        if (c.length >= 1 && !(c in map)) map[c] = b.n;
      });
    });
    Object.assign(map, {
      "诗": 19, "诗篇": 19, "箴": 20, "传": 21, "歌": 22, "赛": 23,
      "太": 40, "可": 41, "路": 42, "约": 43, "徒": 44, "罗": 45,
      "启": 66, "启示录": 66, "创": 1, "创世记": 1
    });
    return map;
  }

  function resolveBook(alias) {
    if (!aliasMap) aliasMap = buildAliasMap();
    alias = (alias || "").replace(/\s/g, "");
    if (!alias) return null;
    if (aliasMap[alias]) return aliasMap[alias];
    for (var len = Math.min(alias.length, 8); len >= 1; len--) {
      var k = alias.slice(0, len);
      if (aliasMap[k]) return aliasMap[k];
    }
    return null;
  }

  /* ---------------- 问句解析 ---------------- */
  function questionIntent(q) {
    if (/为什么|为何|凭什么|什么原因|缘故|怎么会|岂不/.test(q)) return "why";
    if (/怎么|怎样|如何|凭什么得/.test(q)) return "how";
    return "what";
  }

  function parseQuery(raw) {
    var q = (raw || "").trim();
    if (!q) return null;

    var m = q.match(/^([\u4e00-\u9fa5A-Za-z]{0,8})\s*(\d{1,3})\s*[:：章]\s*(\d{1,3})/);
    if (m) {
      var bk = m[1] ? resolveBook(m[1]) : null;
      if (bk) return { type: "ref", book: bk, chap: +m[2], verse: +m[3] };
    }
    var m2 = q.match(/^(\d{1,3})\s*[:：]\s*(\d{1,2})\s*:\s*(\d{1,3})/);
    if (m2) return { type: "ref", book: +m2[1], chap: +m2[2], verse: +m2[3] };

    var qm = q.match(/[「『“"]([^」』”"]{1,24})[」』”"]/);
    var term = qm ? qm[1] : null;

    if (!term) {
      var m3 = q.match(/(?:什么叫|什么是|何为|甚么叫)\s*([^，。？！\s]{1,16})/);
      if (m3) term = m3[1];
    }
    if (!term) {
      var m4 = q.match(/^(.{1,24}?)(?:到底是|究竟)?(?:是什么意思|什么意思|是啥意思|啥意思|的意思是什么|的意思|怎么解释|如何理解|的含义是什么|的含义|是指什么)/);
      if (m4) term = m4[1];
    }
    if (!term) {
      var m5 = q.match(/^(.{1,24}?)\s*(?:原文|原文字义|字义|词义)\s*(?:是什么|什么意思)?$/);
      if (m5) term = m5[1];
      else {
        var m6 = q.match(/^(?:原文|原文字义|字义)\s*[:：]?\s*(.{1,24})$/);
        if (m6) term = m6[1];
      }
    }
    if (!term) term = q;

    term = term.replace(/^(请问|那么|那|我想问|想问|帮忙查一下|查一下)/, "")
               .replace(/[，。？！?、；：\s]+$/g, "").trim();
    if (!term) return null;

    var isQuestion = /为什么|为何|凭什么|怎么|怎样|如何|原因|缘故|能不能|可不可以|可以吗|是否/.test(q) || term.length > 10;
    if (isQuestion) return { type: "sentence", term: q, intent: questionIntent(q) };
    return { type: "term", term: term };
  }

  /* ---------------- 全文检索 ---------------- */
  function searchTerm(term) {
    var S = state.search, hits = [];
    for (var i = 0; i < S.texts.length; i++) {
      if (S.texts[i].indexOf(term) >= 0) {
        var ref = S.refs[i];
        hits.push({
          idx: i,
          b: Math.floor(ref / 1000000),
          c: Math.floor((ref % 1000000) / 1000),
          v: ref % 1000,
          text: S.texts[i]
        });
      }
    }
    return hits;
  }

  var looseCache = {};
  function looseRe(chunk) {
    if (looseCache[chunk]) return looseCache[chunk];
    var re = null;
    if (chunk.length >= 2 && chunk.length <= 4) {
      var body = chunk.split("").map(function (ch) {
        return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }).join("[了的着他她们约翰]{0,2}");
      re = new RegExp(body);
    }
    looseCache[chunk] = re;
    return re;
  }

  function searchLoose(term) {
    var re = looseRe(term);
    if (!re) return [];
    var S = state.search, out = [];
    for (var i = 0; i < S.texts.length && out.length < 120; i++) {
      if (S.texts[i].indexOf(term) >= 0) continue;
      if (re.test(S.texts[i])) {
        var ref = S.refs[i];
        out.push({
          idx: i,
          b: Math.floor(ref / 1000000),
          c: Math.floor((ref % 1000000) / 1000),
          v: ref % 1000,
          text: S.texts[i]
        });
      }
    }
    return out;
  }

  function hasChunk(s, chunk) {
    if (s.indexOf(chunk) >= 0) return true;
    var re = looseRe(chunk);
    return !!(re && re.test(s));
  }

  function pickRepresentatives(hits, cap) {
    if (hits.length <= cap) return hits.slice();
    var byBook = {}, order = [];
    hits.forEach(function (h) {
      if (!byBook[h.b]) { byBook[h.b] = []; order.push(h.b); }
      byBook[h.b].push(h);
    });
    var out = [], round = 0, guard = 0;
    while (out.length < cap && guard++ < 500) {
      var added = false;
      for (var i = 0; i < order.length && out.length < cap; i++) {
        var arr = byBook[order[i]];
        if (round < arr.length) { out.push(arr[round]); added = true; }
      }
      if (!added) break;
      round++;
    }
    out.sort(function (a, b) { return a.idx - b.idx; });
    return out;
  }

  /* ---------------- 原文对齐 ---------------- */
  function alignTerm(raw, term) {
    if (!raw) return [];
    var plain = "", tags = [], i = 0, m;
    var re = /<W([GH])([A-Z]?)(\d+)>|[{}]/g;
    while ((m = re.exec(raw))) {
      plain += raw.slice(i, m.index);
      i = re.lastIndex;
      if (m[0].charAt(0) === "<" && m[2] !== "T") tags.push({ pos: plain.length, key: m[1] + m[3] });
    }
    plain += raw.slice(i);

    var keys = [], seen = {};
    var from = 0, at;
    while ((at = plain.indexOf(term, from)) >= 0) {
      var s = at, e = at + term.length;
      tags.forEach(function (t) {
        var ch = t.pos - 1;
        if (ch >= s && ch < e && !seen[t.key]) { seen[t.key] = 1; keys.push(t.key); }
      });
      from = at + 1;
      if (keys.length > 4) break;
    }
    return keys;
  }

  /* ---------------- 注释 ---------------- */
  var NOTE_PRIORITY = ["原文字义", "文意注解", "灵意注解", "话中之光", "注解"];

  function noteSnippet(chapter, verse, term) {
    if (!chapter || !chapter.note) return null;
    var parts = chapter.note[String(verse)];
    if (!parts || !parts.length) return null;

    var picked = [];
    NOTE_PRIORITY.forEach(function (label) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].l === label && parts[i].t) { picked.push({ l: label, t: parts[i].t }); break; }
      }
    });
    if (!picked.length) {
      for (var i = 0; i < parts.length; i++) if (parts[i].t) { picked.push({ l: parts[i].l || "注解", t: parts[i].t }); break; }
    }
    if (term) {
      picked.sort(function (a, b) {
        return (a.t.indexOf(term) >= 0 ? 0 : 1) - (b.t.indexOf(term) >= 0 ? 0 : 1);
      });
    }
    return picked.slice(0, 2).map(function (p) {
      var t = p.t;
      if (t.length > 320) {
        var at = term ? t.indexOf(term) : -1;
        var start = at > 120 ? at - 120 : 0;
        t = (start > 0 ? "…" : "") + t.slice(start, start + 320) + "…";
      }
      return { l: p.l, t: t };
    });
  }

  /* ---------------- 渲染工具 ---------------- */
  function highlight(text, term) {
    if (!term) return esc(text);
    var out = "", from = 0, at;
    while ((at = text.indexOf(term, from)) >= 0) {
      out += esc(text.slice(from, at)) + "<mark>" + esc(term) + "</mark>";
      from = at + term.length;
    }
    return out + esc(text.slice(from));
  }

  function hlChunks(text, chunks) {
    var out = esc(text);
    chunks.forEach(function (c) { out = out.split(esc(c)).join("<mark>" + esc(c) + "</mark>"); });
    return out;
  }

  function verseText(b, c, v) {
    var ch = chapterOf(b, c);
    if (!ch) return null;
    for (var j = 0; j < ch.v.length; j++) if (ch.v[j][0] === v) return ch.v[j][1];
    return null;
  }

  function hitHTML(h, chunks) {
    var m = bookMeta(h.b);
    return '<div class="hit"><div class="hithead"><span class="hitref">' + esc(m ? m.name : "") +
      " " + h.c + ":" + h.v + "</span>" +
      '<button type="button" class="openbtn" data-b="' + h.b + '" data-c="' + h.c +
      '" data-v="' + h.v + '">上下文 ›</button></div>' +
      '<div class="hittxt">' + hlChunks(h.text, chunks) + "</div></div>";
  }

  /* ================= 问：查词 ================= */
  function renderLoading(msg) {
    askResult.innerHTML = '<div class="loading">' + esc(msg || "检索中…") + "</div>";
  }

  function renderNoHit(term) {
    askResult.innerHTML =
      '<div class="card"><h2>没有找到</h2>' +
      '<p class="none">全书没有「' + esc(term) + '」这个字符串。</p>' +
      '<p class="hint">可能是写法不同（例如「虚心」与「灵里贫穷」），可以换个说法，或直接在「读」里翻到那一节。</p></div>';
  }

  function lexCardsHTML(keys) {
    var html = "";
    keys.forEach(function (k) {
      var e = state.lex[k], c = state.conc[k];
      if (!e && !c) return;
      html += '<div class="card lexcard"><h2>原文线索 <span class="src">CBOL · 按具体程度排序</span></h2>';
      html += '<div class="lexhead"><span class="lexorig">' + esc(e ? e.o : "") + "</span>" +
        '<span class="lexnum">' + esc(k) + "</span>" +
        (c ? '<span class="lexcnt">全书 ' + c[0] + " 处</span>" : "") + "</div>";
      if (c && c[1] && c[1].length) {
        html += '<div class="trans">在和合本里译作：' + c[1].map(function (p) {
          return '<button type="button" class="chip" data-q="' + esc(p[0]) + '">' + esc(p[0]) + " " + p[1] + "</button>";
        }).join("") + "</div>";
      }
      if (e) {
        html += '<details class="lexd"><summary>义项与用法（CBOL）</summary><div class="lexbody">' + esc(e.t) + "</div></details>";
      }
      html += "</div>";
    });
    return html;
  }

  function renderTermResult(term, hits) {
    var otCount = 0, ntCount = 0, byBook = {};
    hits.forEach(function (h) {
      if (h.b <= 39) otCount++; else ntCount++;
      var m = bookMeta(h.b), k = m ? m.name : String(h.b);
      byBook[k] = (byBook[k] || 0) + 1;
    });

    var reps = pickRepresentatives(hits, 12);
    var truncated = hits.length > reps.length;

    var html = '<div class="card"><h2>检索结果 <span class="src">和合本全文</span></h2>';
    html += '<div class="hitsum"><span class="term">' + esc(term) + "</span>" +
      '<span class="cnt">全书 ' + hits.length + " 处</span>" +
      '<span class="split">旧约 ' + otCount + " · 新约 " + ntCount + "</span></div>";
    var bok = Object.keys(byBook).map(function (k) { return [k, byBook[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
    html += '<div class="dist">' + bok.map(function (x) {
      return '<span class="tag">' + esc(x[0]) + " " + x[1] + "</span>";
    }).join("") + "</div>";
    if (truncated) {
      html += '<p class="hint">共 ' + hits.length + " 处，下面挑 " + reps.length + " 节作代表（按书卷轮流取样）。</p>";
    }
    html += "</div>";

    html += '<div id="lexHost"></div>';
    html += '<div class="card"><h2>经文 <span class="src">和合本</span></h2><div id="verseHost">' +
      '<div class="loading">正在载入经文…</div></div></div>';
    html += '<p class="hint" id="tailHint"></p>';
    askResult.innerHTML = html;

    var verseHost = $("verseHost"), lexHost = $("lexHost"), tail = $("tailHint");
    var shown = 0;
    var keysSeen = {}, keys = [];

    // 章节按代表顺序去重
    var chaps = [], seenC = {};
    reps.forEach(function (r) {
      var k = r.b + ":" + r.c;
      if (!seenC[k]) { seenC[k] = 1; chaps.push(r); }
    });

    // 索引可能已在预热中
    var lexReady = Promise.all([ensureLex(), ensureConc()]);
    lexReady.then(function () {
      if (lexHost) lexHost.innerHTML = lexCardsHTML(keys);
    }).catch(function () {});

    var i = 0;
    function step() {
      if (i >= chaps.length) {
        if (tail) tail.textContent = "";
        return;
      }
      var cx = chaps[i++];
      loadChapter(cx.b, cx.c).then(function (ch) {
        var part = "";
        reps.forEach(function (r) {
          if (r.b !== cx.b || r.c !== cx.c) return;
          var snip = noteSnippet(ch, r.v, term);
          part += '<div class="hit"><div class="hithead"><span class="hitref">' +
            esc(bookMeta(r.b).name) + " " + r.c + ":" + r.v + "</span>" +
            '<button type="button" class="openbtn" data-b="' + r.b + '" data-c="' + r.c +
            '" data-v="' + r.v + '">上下文 ›</button></div>' +
            '<div class="hittxt">' + highlight(r.text, term) + "</div>";
          if (snip && snip.length) {
            snip.forEach(function (p) {
              part += '<div class="hitnote"><span class="plabel">' + esc(p.l) + "</span>" +
                '<span class="ptext">' + esc(p.t) + "</span></div>";
            });
          } else {
            part += '<div class="hitnote muted">（这一节在基督徒文摘里没有逐节注解）</div>';
          }
          part += "</div>";
          shown++;
        });
        if (shown === 0) verseHost.innerHTML = "";
        if (verseHost.querySelector(".loading")) verseHost.innerHTML = "";
        verseHost.insertAdjacentHTML("beforeend", part);

        // 原文线索：从已载入的章节里抽取
        reps.forEach(function (r) {
          if (r.b !== cx.b || r.c !== cx.c) return;
          var ch2 = chapterOf(r.b, r.c);
          if (!ch2) return;
          for (var j = 0; j < ch2.v.length; j++) {
            if (ch2.v[j][0] !== r.v) continue;
            alignTerm(ch2.v[j][2], term).forEach(function (k) {
              if (!keysSeen[k]) { keysSeen[k] = 1; keys.push(k); }
            });
          }
        });
        keys.sort(function (a, b) {
          var ca = state.conc && state.conc[a] ? state.conc[a][0] : 99999;
          var cb = state.conc && state.conc[b] ? state.conc[b][0] : 99999;
          return ca - cb;
        });
        if (state.lex || state.conc) lexHost.innerHTML = lexCardsHTML(keys.slice(0, 2));

        if (tail) tail.textContent = i < chaps.length ? "已载入 " + i + "/" + chaps.length + " 处…" : "";
        step();
      }).catch(function () { step(); });
    }
    step();
  }

  /* ================= 问：句子 ================= */
  var CUE = {
    why: ["因为", "为要", "目的", "所以", "缘故", "原因", "因着", "因此", "是为", "叫他", "免得"],
    how: ["如何", "怎样", "方法", "藉着", "借着", "应当", "就当", "要"],
    what: ["就是", "是指", "意思是", "即", "称为", "所谓", "指的是", "乃是", "意即"]
  };
  var LABEL_BONUS = { "文意注解": 4, "原文字义": 3, "灵意注解": 3, "话中之光": 0, "注解": 1 };

  function splitSentences(text) {
    if (!text) return [];
    var out = [], buf = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      buf += ch;
      if ("。！？；".indexOf(ch) >= 0 || ch === "\n") {
        var s = buf.trim();
        if (s.length >= 8 && s.length <= 260) out.push(s);
        buf = "";
      }
    }
    var rest = buf.trim();
    if (rest.length >= 8 && rest.length <= 260) out.push(rest);
    return out;
  }

  function extractChunks(q) {
    var s = q;
    var stops = [
      "为什么说", "为什么", "为何", "凭什么", "什么原因", "缘故", "究竟", "到底", "请问", "那么",
      "什么是", "什么叫", "是什么", "何谓", "怎么", "怎样", "如何", "能不能", "可以吗",
      "圣经", "里面", "之中", "记载", "提到", "吗", "呢", "吧", "啊", "的", "了", "着", "么"
    ];
    stops.forEach(function (w) { s = s.split(w).join(" "); });
    s = s.replace(/[，。？！?、；："'“”‘’「」『』()（）《》…]/g, " ");
    var out = [], seen = {};
    s.split(/\s+/).forEach(function (x) {
      x = x.trim().replace(/^[说讲问答叫]/g, "");
      if (x.length >= 2 && x.length <= 16 && !seen[x]) { seen[x] = 1; out.push(x); }
    });
    return out;
  }

  function haystack() {
    if (!state.search.all) state.search.all = state.search.texts.join("\u0001");
    return state.search.all;
  }
  function existsSub(s) { return haystack().indexOf(s) >= 0; }

  function segmentChunk(chunk) {
    if (existsSub(chunk)) return [chunk];
    var out = [], i = 0;
    while (i < chunk.length) {
      var found = null;
      for (var L = Math.min(6, chunk.length - i); L >= 2; L--) {
        var sub = chunk.substr(i, L);
        if (existsSub(sub)) { found = sub; break; }
      }
      if (found) { out.push(found); i += found.length; }
      else i += 1;
    }
    return out;
  }

  function buildChunks(q) {
    var raw = extractChunks(q), out = [], seen = {};
    raw.forEach(function (c) {
      segmentChunk(c).forEach(function (x) {
        if (x.length >= 2 && !seen[x]) { seen[x] = 1; out.push(x); }
      });
    });
    return out.slice(0, 4);
  }

  function scoreVerses(chunks) {
    var scored = {}, order = [];
    chunks.forEach(function (c) {
      var hits = searchTerm(c);
      var weight = 1 / Math.log(2 + hits.length);
      hits.forEach(function (h) {
        var k = h.idx;
        if (!scored[k]) { scored[k] = { h: h, score: 0, matched: [] }; order.push(k); }
        scored[k].score += weight;
        if (scored[k].matched.indexOf(c) < 0) scored[k].matched.push(c);
      });
      if (hits.length < 3) {
        searchLoose(c).forEach(function (h) {
          var k = h.idx;
          if (!scored[k]) { scored[k] = { h: h, score: 0, matched: [] }; order.push(k); }
          scored[k].score += weight * 0.55;
          if (scored[k].matched.indexOf(c) < 0) scored[k].matched.push(c);
        });
      }
    });
    return order.map(function (k) { return scored[k]; }).sort(function (a, b) { return b.score - a.score; });
  }

  function renderAnswer(question, chunks, intent, ranked) {
    var chunkHits = chunks.map(function (c) { return searchTerm(c).length; });
    var primaryIdx = 0;
    for (var pi = 1; pi < chunkHits.length; pi++) if (chunkHits[pi] < chunkHits[primaryIdx]) primaryIdx = pi;
    var weights = chunks.map(function (c, i) { return 1 / Math.log(2 + chunkHits[i]); });
    var cues = CUE[intent] || [];

    var chapters = [], seenC = {};
    ranked.slice(0, 8).forEach(function (x) {
      var k = x.h.b + ":" + x.h.c;
      if (!seenC[k]) { seenC[k] = 1; chapters.push(x.h); }
    });
    chapters = chapters.slice(0, 5);

    var html = '<div class="card"><h2>问题 <span class="src">在全书资料里找现成的解释</span></h2>';
    html += '<div class="qline">' + esc(question) + "</div>";
    html += '<div class="qmeta">关键词：<b>' + chunks.map(esc).join("</b> · <b>") + "</b>" +
      '<span class="sep">|</span>意图：' + ({ why: "问原因", how: "问做法", what: "问含义" }[intent] || "问含义") +
      "</div></div>";
    html += '<div id="vHost"></div><div id="qHost"></div>';
    html += '<p class="hint" id="tailHint">正在资料里找…</p>';
    askResult.innerHTML = html;

    var vHost = $("vHost"), qHost = $("qHost"), tail = $("tailHint");
    var pool = [], seenText = {}, loaded = 0;

    function rerender() {
      // 经文：用已找到的注解回填排序
      var chapQ = {}, verseQ = {};
      pool.slice(0, 5).forEach(function (p) {
        var ck = p.u.b + ":" + p.u.c;
        chapQ[ck] = (chapQ[ck] || 0) + 1;
        if (p.u.v) verseQ[ck + ":" + p.u.v] = (verseQ[ck + ":" + p.u.v] || 0) + 1;
      });
      var rescored = ranked.slice(0, 40).map(function (x) {
        var h = x.h, ck = h.b + ":" + h.c, vk = ck + ":" + h.v, s = x.score;
        s += 1.5 * (chapQ[ck] || 0);
        s += 3 * (verseQ[vk] || 0);
        if (p.chapters && p.chapters[ck]) {
          var ch = chapterOf(h.b, h.c);
          if (ch && ch.note && ch.note[String(h.v)]) {
            var note = ch.note[String(h.v)];
            for (var j = 0; j < note.length; j++) {
              if (note[j].t && hasChunk(note[j].t, chunks[primaryIdx])) { s += 2; break; }
            }
          }
        }
        return { h: h, s: s };
      }).sort(function (a, b) { return b.s - a.s; });

      var top = rescored.slice(0, 3).map(function (x) { return x.h; });
      vHost.innerHTML = '<div class="card"><h2>关键词所在经文 <span class="src">和合本</span></h2>' +
        top.map(function (h) { return hitHTML(h, chunks); }).join("") + "</div>";

      if (pool.length) {
        var top5 = pool.slice(0, 5);
        var anyCue = top5.some(function (x) { return x.cue; });
        var body = '<div class="card"><h2>资料原文 <span class="src">逐条摘录，未改写</span></h2>';
        top5.forEach(function (p) {
          var loc = p.u.v ? (esc(bookMeta(p.u.b).name) + " " + p.u.c + ":" + p.u.v)
                          : (esc(bookMeta(p.u.b).name) + " 第 " + p.u.c + " 章");
          body += '<div class="quote"><div class="qhead">' + esc(p.u.src) + " · " + loc +
            ' · <span class="qlabel">' + esc(p.u.label) + "</span></div>" +
            '<div class="qbody">' + hlChunks(p.s, chunks) + "</div></div>";
        });
        if (!anyCue && intent === "why") {
          body += '<p class="hint">资料里没有出现「因为／所以／为要」这类因果句，下面列的是与问题相关的论述，请自行判断。</p>';
        }
        qHost.innerHTML = body + "</div>";
      }
    }

    var i = 0;
    function step() {
      if (i >= chapters.length) return finish();
      var cx = chapters[i++];
      loadChapter(cx.b, cx.c).then(function (ch) {
        loaded++;
        p_chapters(cx);
        var units = [];
        if (ch.note) {
          Object.keys(ch.note).forEach(function (v) {
            ch.note[v].forEach(function (part) {
              if (!part.t || !part.l) return;
              units.push({ src: "基督徒文摘解经系列", b: cx.b, c: cx.c, v: +v, label: part.l || "注解", text: part.t });
            });
          });
        }
        if (ch.chap) {
          ch.chap.forEach(function (item) {
            units.push({ src: item.s, b: cx.b, c: cx.c, v: 0, label: "整章", text: (item.p || []).join("\n") });
          });
        }
        units.forEach(function (u) {
          splitSentences(u.text).forEach(function (s) {
            var matched = [], wsum = 0;
            chunks.forEach(function (c, ci) {
              if (hasChunk(s, c)) { matched.push(c); wsum += weights[ci]; }
            });
            if (!matched.length) return;
            if (chunks.length > 1 && matched.indexOf(chunks[primaryIdx]) < 0) return;
            var rest = s;
            matched.forEach(function (c) { rest = rest.split(c).join(""); });
            var substance = rest.replace(/[\s「」『』“”"（）()【】〔〕：，。！？；、·…—]/g, "").length;
            if (substance < 10) return;
            var cueHit = 0;
            cues.forEach(function (cw) { if (s.indexOf(cw) >= 0) cueHit = 1; });
            var score = wsum * 6 + cueHit * 3 + (LABEL_BONUS[u.label] || 0);
            if (substance >= 40) score += 2;
            if (substance >= 80) score += 1;
            if (u.v) {
              var vt = verseText(u.b, u.c, u.v);
              if (vt) {
                var cov = 0;
                chunks.forEach(function (c) { if (hasChunk(vt, c)) cov++; });
                score += cov * 1.5;
              }
            }
            var key = s.replace(/\s/g, "").slice(0, 40);
            if (seenText[key]) return;
            seenText[key] = 1;
            pool.push({ u: u, s: s, score: score, cue: cueHit, substance: substance });
          });
        });
        pool.sort(function (a, b) {
          if (b.score !== a.score) return b.score - a.score;
          return b.substance - a.substance;
        });
        rerender();
        if (tail) tail.textContent = i < chapters.length ? "已找到 " + Math.min(pool.length, 5) + " 条，继续看别的章节…" : "";
        step();
      }).catch(function () { step(); });
    }

    var _chapters = {};
    function p_chapters(cx) { _chapters[cx.b + ":" + cx.c] = 1; }

    function finish() {
      if (tail) tail.textContent = pool.length ? "" : "";
      if (!pool.length) {
        qHost.innerHTML = '<div class="card"><h2>没有找到直接的解释</h2>' +
          '<p class="none">这些资料里没有直接讲到「' + esc(question) + "」的段落。</p>" +
          '<p class="hint">可以换个说法，或者点上面的「上下文」自己读这一章的注解。</p></div>';
      }
    }

    // 让 rerender 能拿到已载入的章节标记
    var p = { chapters: _chapters };

    step();
  }

  /* ---------------- 结果交互 ---------------- */
  function initResultDelegation() {
    askResult.addEventListener("click", function (e) {
      var chip = e.target.closest(".chip[data-q]");
      if (chip) { qInput.value = chip.getAttribute("data-q"); runQuery(qInput.value); return; }
      var open = e.target.closest(".openbtn");
      if (open) {
        setView("read");
        goTo(+open.getAttribute("data-b"), +open.getAttribute("data-c"), +open.getAttribute("data-v"));
      }
    });
  }

  /* ---------------- 查询入口 ---------------- */
  function runQuery(raw) {
    var parsed = parseQuery(raw);
    if (!parsed) return;

    if (parsed.type === "ref") {
      setView("read");
      goTo(parsed.book, parsed.chap, parsed.verse);
      return;
    }

    if (parsed.type === "sentence") {
      var q = parsed.term;
      renderLoading("拆解问题…");
      ensureSearch().then(function () {
        var chunks = buildChunks(q);
        if (!chunks.length) { renderNoHit(q); return; }
        var ranked = scoreVerses(chunks);
        if (!ranked.length) { renderNoHit(chunks[0]); return; }
        renderAnswer(q, chunks, parsed.intent, ranked);
      }).catch(function () { renderLoading("索引载入失败"); });
      return;
    }

    var term = parsed.term;
    renderLoading("检索「" + term + "」…");
    ensureSearch().then(function () {
      var hits = searchTerm(term);
      if (!hits.length) { renderNoHit(term); return; }
      renderTermResult(term, hits);
    }).catch(function () { renderLoading("索引载入失败"); });
  }

  /* ---------------- 视图 ---------------- */
  function setView(v) {
    state.view = v;
    $("tabAsk").classList.toggle("on", v === "ask");
    $("tabRead").classList.toggle("on", v === "read");
    askView.hidden = v !== "ask";
    readView.hidden = v !== "read";
    $("readControls").hidden = v !== "read";
  }

  /* ================= 读 ================= */
  function buildBookSelect() {
    var ot = document.createElement("optgroup"); ot.label = "旧约";
    var nt = document.createElement("optgroup"); nt.label = "新约";
    BOOKS.forEach(function (b) {
      var o = document.createElement("option");
      o.value = b.n; o.textContent = b.name;
      (b.n <= 39 ? ot : nt).appendChild(o);
    });
    bookSel.appendChild(ot); bookSel.appendChild(nt);
  }

  function buildChapSelect(max) {
    chapSel.innerHTML = "";
    for (var i = 1; i <= max; i++) {
      var o = document.createElement("option");
      o.value = i; o.textContent = "第 " + i + " 章";
      chapSel.appendChild(o);
    }
  }

  function renderChapter(ch) {
    var meta = bookMeta(state.book);
    var html = '<h1 class="chaptitle">' + esc(meta.name) + " 第 " + state.chap + " 章</h1>";
    if (ch.overview && ch.overview.length) {
      html += '<details class="overview"><summary>本章纲要（基督徒文摘）</summary><div class="body">';
      ch.overview.forEach(function (p) { html += "<p>" + esc(p) + "</p>"; });
      html += "</div></details>";
    }
    ch.v.forEach(function (row) {
      html += '<p class="verse" data-v="' + row[0] + '"><span class="num">' + row[0] + "</span>" + esc(row[1]) + "</p>";
    });
    readerEl.innerHTML = html;

    Array.prototype.forEach.call(readerEl.querySelectorAll(".verse"), function (el) {
      el.addEventListener("click", function () {
        state.verse = parseInt(el.getAttribute("data-v"), 10);
        markActive(); renderPanel(ch); syncHash();
        if (window.matchMedia("(max-width: 899px)").matches) {
          panelEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
    markActive();
  }

  function markActive() {
    Array.prototype.forEach.call(readerEl.querySelectorAll(".verse"), function (el) {
      el.classList.toggle("active", parseInt(el.getAttribute("data-v"), 10) === state.verse);
    });
  }

  var SN_RE = /<W([GH])([A-Z]?)(\d+)>/g;
  var TOKEN_RE = /\{|\}|<W([GH])(\d+)>/g;

  function renderStrongLine(raw) {
    var src = raw.replace(/<WT[GH]\d+>/g, "");
    var out = "", last = 0, implied = false, m;
    TOKEN_RE.lastIndex = 0;
    function put(text, isImplied) {
      if (!text) return;
      out += isImplied ? '<span class="implied">' + esc(text) + "</span>" : esc(text);
    }
    while ((m = TOKEN_RE.exec(src))) {
      put(src.slice(last, m.index), implied);
      if (m[0] === "{") implied = true;
      else if (m[0] === "}") implied = false;
      else out += '<a class="sn" data-k="' + m[1] + m[2] + '">' + m[1] + m[2] + "</a>";
      last = TOKEN_RE.lastIndex;
    }
    put(src.slice(last), implied);
    return out;
  }

  function collectKeys(raw) {
    var keys = [], seen = {}, m;
    var src = raw.replace(/<WT[GH]\d+>/g, "");
    SN_RE.lastIndex = 0;
    while ((m = SN_RE.exec(src))) {
      var k = m[1] + m[3];
      if (!seen[k]) { seen[k] = 1; keys.push(k); }
    }
    return keys;
  }

  function lexCard(keys) {
    var lex = state.lex || {}, html = "";
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], e = lex[k];
      if (!e) continue;
      var preview = (e.t || "").split("\n").slice(1).join(" ").slice(0, 46);
      html += '<details class="lexitem" id="lex-' + k + '"><summary>' +
        '<span class="lexorig">' + esc(e.o) + "</span>" +
        '<span class="lexnum">' + esc(k) + "</span>" +
        '<span class="lexprev">' + esc(preview) + "</span></summary>" +
        '<div class="lexbody">' + esc(e.t) + "</div></details>";
    }
    return html || '<div class="none">词条库中未找到对应条目</div>';
  }

  function noteCard(ch) {
    var note = ch.note && ch.note[String(state.verse)];
    if (!note || !note.length) {
      return '<div class="card"><h2>逐节注解 <span class="src">基督徒文摘解经系列</span></h2>' +
        '<div class="none">本模块没有这一节的逐节注解（本章其余资料见下方）</div></div>';
    }
    var html = '<div class="card"><h2>逐节注解 <span class="src">基督徒文摘解经系列</span></h2>';
    note.forEach(function (part) {
      if (!part.l) {
        html += '<div class="part"><div class="scripture" style="font-size:16px;color:var(--ink-2)">' + esc(part.t) + "</div></div>";
      } else {
        html += '<div class="part"><span class="plabel">' + esc(part.l) + "</span>" +
          '<span class="ptext">' + esc(part.t) + "</span></div>";
      }
    });
    return html + "</div>";
  }

  function chapCard(ch) {
    if (!ch.chap || !ch.chap.length) return "";
    var html = '<div class="card"><h2>整章资料 <span class="src">按章收录，非逐节</span></h2>';
    ch.chap.forEach(function (src, i) {
      html += '<details class="block"' + (i === 0 ? " open" : "") + "><summary>" + esc(src.s) + "</summary><div class='body'>";
      src.p.forEach(function (p) { html += "<p>" + esc(p) + "</p>"; });
      html += "</div></details>";
    });
    return html + "</div>";
  }

  function topicCard(ch) {
    var t = ch.t && ch.t[String(state.verse)];
    if (!t || !t.length) return "";
    var html = '<div class="card"><h2>主题 <span class="src">App 内置索引</span></h2><div class="tags">';
    t.forEach(function (x) { html += '<span class="tag">' + esc(x) + "</span>"; });
    return html + "</div></div>";
  }

  function renderPanel(ch) {
    var row = null;
    for (var i = 0; i < ch.v.length; i++) if (ch.v[i][0] === state.verse) row = ch.v[i];
    if (!row) return;

    var meta = bookMeta(state.book);
    var ref = meta.name + " " + state.chap + ":" + state.verse;
    var raw = row[2] || "";
    var keys = collectKeys(raw);

    var html = '<p class="ref">' + esc(ref) + "</p>";
    html += '<div class="card"><h2>经文 <span class="src">和合本</span></h2><div class="scripture">' + esc(row[1]) + "</div></div>";
    html += noteCard(ch);
    if (raw) {
      html += '<div class="card"><h2>原文逐词 <span class="src">信望爱和合本 · Strong 编码</span></h2>' +
        '<div class="strongline">' + renderStrongLine(raw) + "</div>" +
        '<p class="hint">带 {} 的是原文没有、译文补上的词；点编码可跳到词条</p></div>';
    }
    if (keys.length) {
      html += '<div class="card" id="lexbox"><h2>原文词条 <span class="src">CBOL 原文工具书</span></h2>' +
        (state.lex ? lexCard(keys) : '<div class="none">词条载入中…</div>') + "</div>";
    }
    html += chapCard(ch);
    html += topicCard(ch);
    panelEl.innerHTML = html;

    Array.prototype.forEach.call(panelEl.querySelectorAll(".sn"), function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var t = document.getElementById("lex-" + a.getAttribute("data-k"));
        if (t) {
          t.open = true;
          t.scrollIntoView({ behavior: "smooth", block: "center" });
          t.style.transition = "background .3s";
          t.style.background = "var(--hl)";
          setTimeout(function () { t.style.background = ""; }, 900);
        }
      });
    });

    if (keys.length && !state.lex) {
      ensureLex().then(function () {
        var box = document.getElementById("lexbox");
        if (box) box.innerHTML = '<h2>原文词条 <span class="src">CBOL 原文工具书</span></h2>' + lexCard(keys);
      }).catch(function () {});
    }
  }

  function syncHash() {
    var h = "#" + state.book + "/" + state.chap + "/" + state.verse;
    if (location.hash !== h) history.replaceState(null, "", h);
  }

  function parseHash() {
    var h = (location.hash || "").replace(/^#/, "");
    var p = h.split("/");
    var b = parseInt(p[0], 10), c = parseInt(p[1], 10), v = parseInt(p[2], 10);
    if (!b || !c) return null;
    return { b: b, c: c, v: v || 1 };
  }

  function goTo(book, chap, verse) {
    var meta = bookMeta(book); if (!meta) return;
    if (chap < 1) chap = 1;
    if (chap > meta.c) chap = meta.c;
    state.book = book; state.chap = chap; state.verse = verse || 1;
    bookSel.value = String(book);
    buildChapSelect(meta.c);
    chapSel.value = String(chap);
    readerEl.innerHTML = '<div class="loading">载入中…</div>';
    panelEl.innerHTML = "";

    var wanted = book + ":" + chap;
    loadChapter(book, chap).then(function (ch) {
      if (state.book + ":" + state.chap !== wanted) return;   // 已经翻到别处
      renderChapter(ch);
      renderPanel(ch);
      syncHash();
      // 预取下一章
      setTimeout(function () {
        if (chap < meta.c && state.book + ":" + state.chap === wanted) loadChapter(book, chap + 1).catch(function () {});
      }, 800);
    }).catch(function (err) {
      readerEl.innerHTML = '<div class="loading">载入失败：' + esc(err.message) + "</div>";
    });
  }

  /* ---------------- PWA ---------------- */
  function setupPWA() {
    if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      });
    }
    var bar = $("installBar"), text = $("installText"), go = $("installGo");
    if (!bar) return;
    var standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (standalone) { bar.hidden = true; return; }
    if (localStorage.getItem("jd_install_dismissed") === "1") return;

    var deferred = null;
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferred = e;
      text.textContent = "装到桌面，断网也能用";
      go.hidden = false;
      bar.hidden = false;
    });

    var ua = navigator.userAgent;
    var isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.indexOf("Mac") >= 0 && "ontouchend" in document);
    if (isIOS) {
      text.textContent = "点底部「分享」→「添加到主屏幕」，断网也能用";
      bar.hidden = false;
    }

    go.addEventListener("click", function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; go.hidden = true; });
    });
    $("installClose").addEventListener("click", function () {
      bar.hidden = true;
      localStorage.setItem("jd_install_dismissed", "1");
    });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    askView = $("askView"); readView = $("readView");
    readerEl = $("reader"); panelEl = $("panel");
    askResult = $("askResult"); qInput = $("q");
    bookSel = $("bookSel"); chapSel = $("chapSel");

    setupPWA();
    initResultDelegation();
    buildBookSelect();
    setView("ask");

    $("tabAsk").addEventListener("click", function () { setView("ask"); });
    $("tabRead").addEventListener("click", function () {
      setView("read");
      if (!readerEl.querySelector(".verse")) {
        var h = parseHash() || { b: 40, c: 5, v: 1 };
        goTo(h.b, h.c, h.v);
      }
    });

    $("askForm").addEventListener("submit", function (e) { e.preventDefault(); runQuery(qInput.value); });
    Array.prototype.forEach.call(document.querySelectorAll("#examples button"), function (b) {
      b.addEventListener("click", function () { qInput.value = b.getAttribute("data-q"); runQuery(qInput.value); });
    });

    bookSel.addEventListener("change", function () { goTo(parseInt(bookSel.value, 10), 1, 1); });
    chapSel.addEventListener("change", function () { goTo(state.book, parseInt(chapSel.value, 10), 1); });
    $("prevBtn").addEventListener("click", function () {
      if (state.chap > 1) return goTo(state.book, state.chap - 1, 1);
      if (state.book > 1) goTo(state.book - 1, bookMeta(state.book - 1).c, 1);
    });
    $("nextBtn").addEventListener("click", function () {
      var meta = bookMeta(state.book);
      if (state.chap < meta.c) return goTo(state.book, state.chap + 1, 1);
      if (state.book < 66) goTo(state.book + 1, 1, 1);
    });
    window.addEventListener("hashchange", function () {
      var h = parseHash(); if (!h) return;
      setView("read");
      if (h.b !== state.book || h.c !== state.chap) goTo(h.b, h.c, h.v);
      else if (h.v !== state.verse) { state.verse = h.v; markActive(); var ch = chapterOf(state.book, state.chap); if (ch) renderPanel(ch); }
    });

    var qh = (location.hash || "").replace(/^#/, "");
    if (qh.indexOf("q=") === 0) {
      var seed = decodeURIComponent(qh.slice(2));
      qInput.value = seed;
      runQuery(seed);
    } else if (parseHash()) {
      var h = parseHash();
      setView("read");
      goTo(h.b, h.c, h.v);
    }

    // 首屏空闲时预热索引，让第一次搜索不再空等
    setTimeout(warmup, 800);
  }

  function boot() {
    loadScript("data/" + DATA_V + "/books.js").then(function () {
      BOOKS = window.__BOOKS || [];
      init();
    }).catch(function () {
      document.body.insertAdjacentHTML("afterbegin",
        '<div style="padding:20px;color:#a33">数据载入失败，请检查 data/' + DATA_V + "/ 是否存在</div>");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
