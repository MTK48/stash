'use strict';
/* Stash — budget mensuel. Données stockées uniquement sur l'appareil (localStorage). */
var KEY = 'stash.v1', VERSION = '1.6';

/* ---------- calculs (purs) ---------- */
function r2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function parseAmt(s){
  s = String(s == null ? '' : s).replace(/[\s\u00a0\u202f€]/g, '').replace(',', '.');
  if (!/^-?\d*\.?\d*$/.test(s) || s === '' || s === '.' || s === '-') return NaN;
  var n = parseFloat(s); return isFinite(n) ? r2(n) : NaN;
}
function pad(n){ return (n < 10 ? '0' : '') + n; }
function iso(d){ return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function mkey(d){ return iso(d).slice(0, 7); }
function addM(m, k){ return mkey(new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1)); }
var MINP = 15; // écart minimal, en jours, entre deux débuts de mois déclenchés par un revenu
function sgn(t){ return t.type === 'rev' ? t.amt : -t.amt; }
function dayAdd(d, k){ return iso(new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + k)); }
function dayDiff(a, b){
  var u = function(d){ return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); };
  return Math.round((u(b) - u(a)) / 864e5);
}
function inP(t, p){ return t.date >= p.start && (!p.end || t.date < p.end); }
function txP(S, p){ return S.tx.filter(function(t){ return inP(t, p); }); }
function balAt(S, d){ // solde du compte au début du jour d
  var a = S.anchor; if (!a) return 0;
  var s = a.amount;
  S.tx.forEach(function(t){
    if (d > a.date){ if (t.date >= a.date && t.date < d) s += sgn(t); }
    else if (d < a.date){ if (t.date >= d && t.date < a.date) s -= sgn(t); }
  });
  return r2(s);
}
function opener(S){ return S.cats.filter(function(c){ return c.type === 'rev' && c.opens; })[0] || null; }
/* Les « mois » de l'appli. Sans revenu déclencheur : mois calendaires. Avec : un mois démarre à chaque encaissement de ce revenu. */
function periods(S, today){
  var op = opener(S), out = [], first = S.anchor ? S.anchor.date : today, i;
  S.tx.forEach(function(t){ if (t.date < first) first = t.date; });
  if (op){
    var b = [first], last = null;
    S.tx.filter(function(t){ return t.cat === op.id; }).map(function(t){ return t.date; }).sort().forEach(function(d){
      if (last && dayDiff(last, d) < MINP) return;
      last = d; if (d > first) b.push(d);
    });
    for (i = 0; i < b.length; i++) out.push({ start: b[i], end: b[i + 1] || null });
  } else {
    var m = first.slice(0, 7), endM = addM(today.slice(0, 7), 1);
    for (; m <= endM; m = addM(m, 1)) out.push({ start: m + '-01', end: addM(m, 1) + '-01', cal: true });
  }
  return out;
}
function curIndex(ps, today){
  for (var i = ps.length - 1; i >= 0; i--) if (ps[i].start <= today && (!ps[i].end || today < ps[i].end)) return i;
  return today < ps[0].start ? 0 : ps.length - 1;
}
function stats(S, p){
  var dep = 0, rev = 0, ep = 0, by = {}, n = {};
  txP(S, p).forEach(function(t){
    if (t.type === 'rev') rev += t.amt; else if (t.type === 'ep') ep += t.amt; else dep += t.amt;
    by[t.cat] = (by[t.cat] || 0) + t.amt; n[t.cat] = (n[t.cat] || 0) + 1;
  });
  var pDep = 0, pRev = 0, pEp = 0, resteDep = 0, resteRev = 0, resteFixe = 0, resteEp = 0;
  S.cats.forEach(function(c){
    var real = by[c.id] || 0;
    var reste = c.fixed ? (n[c.id] ? 0 : c.plan) : Math.max(0, c.plan - real);
    if (c.type === 'rev'){ pRev += c.plan; resteRev += reste; }
    else if (c.type === 'ep'){ pEp += c.plan; resteEp += reste; }
    else { pDep += c.plan; resteDep += reste; if (c.fixed) resteFixe += reste; }
  });
  var start = balAt(S, p.start);
  return { dep: r2(dep), rev: r2(rev), by: by, n: n, pDep: r2(pDep), pRev: r2(pRev), start: start,
    ep: r2(ep), pEp: r2(pEp), resteEp: r2(resteEp),
    saved: r2(rev - dep), bal: r2(start + rev - dep - ep), resteDep: r2(resteDep), resteRev: r2(resteRev),
    resteFixe: r2(resteFixe), proj: r2(start + rev - dep - ep - resteDep - resteEp + resteRev) };
}
/* Saisie automatique : une catégorie fixe avec un jour du mois (c.auto) est enregistrée toute seule quand ce jour est atteint.
   L'appli ne tourne pas en arrière-plan : le rattrapage se fait à l'ouverture, avec la bonne date. Renvoie le nombre d'opérations ajoutées. */
function autoRun(S, today){
  var n = 0;
  S.cats.forEach(function(c){
    if (!c.auto || !c.fixed || !(c.plan > 0) || c.opens || !c.autoFrom) return;
    for (var m = c.autoFrom.slice(0, 7); m <= today.slice(0, 7); m = addM(m, 1)){
      var dim = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate(), d = m + '-' + pad(Math.min(c.auto, dim));
      if (d < c.autoFrom || d > today || (c.autoLast && d <= c.autoLast)) continue;
      c.autoLast = d; // une échéance n'est traitée qu'une fois : une ligne supprimée à la main ne revient pas
      var pm = addM(m, -1), prev = pm + '-' + pad(Math.min(c.auto, new Date(+pm.slice(0, 4), +pm.slice(5, 7), 0).getDate()));
      if (S.tx.some(function(t){ return t.cat === c.id && t.date > prev && t.date <= d; })) continue; // déjà saisie à la main depuis la dernière échéance
      var t = { id: uid(), date: d, amt: c.plan, type: c.type, cat: c.id, note: '', auto: true, pot: c.type === 'ep' ? (c.pot || '') : '' };
      S.tx.push(t); n++;
      if (t.pot) S.pots.forEach(function(q){ if (q.id === t.pot) q.bal = r2(q.bal + t.amt); });
    }
  });
  return n;
}
function defaults(){
  var i = 0, c = function(name, type, fixed, opens){ return { id: 'c' + (++i), name: name, type: type, plan: 0, fixed: !!fixed, opens: !!opens }; };
  var o = { app: 'stash', v: 2, anchor: null, tx: [], pots: [],
    cats: [c('Alimentation', 'dep'), c('Logement', 'dep', 1), c('Transports', 'dep'), c('Abonnements', 'dep', 1),
           c('Loisirs', 'dep'), c('Autres dépenses', 'dep'), c('Salaire', 'rev', 1, 1), c('Autres revenus', 'rev')] };
  o.cats[0].box = o.cats[0].apart = true; o.cats[5].box = true;
  return o;
}
/* Où une catégorie s'affiche. Dépenses : « box » = grosse case (montant + Payer), « budget » = ligne avec barre, « fixed » = charge fixe. */
function groupOf(c){ return c.type === 'dep' ? (c.box ? 'box' : c.fixed ? 'fixed' : 'budget') : c.type; }
/* Déplace une catégorie d'un cran (d = -1 ou 1) parmi celles de son groupe. Renvoie false si elle est déjà au bout. */
function moveCat(S, id, d){
  var c = S.cats.filter(function(x){ return x.id === id; })[0]; if (!c) return false;
  var g = groupOf(c), idx = [];
  S.cats.forEach(function(x, i){ if (groupOf(x) === g) idx.push(i); });
  var k = idx.indexOf(S.cats.indexOf(c)), j = k + d;
  if (j < 0 || j >= idx.length) return false;
  var a = idx[k], b = idx[j], t = S.cats[a]; S.cats[a] = S.cats[b]; S.cats[b] = t;
  return true;
}
/* Version 1.6 : Alimentation et Autres dépenses deviennent les deux grosses cases (créées si elles n'existent plus). Une seule fois. */
function migrate2(o){
  var find = function(re){ return o.cats.filter(function(x){ return x.type === 'dep' && re.test(String(x.name).trim()); })[0]; };
  var mk = function(name){ return { id: uid(), name: name, type: 'dep', plan: 0, fixed: false, opens: false, auto: 0 }; };
  var al = find(/^alimentation$/i), au = find(/^autres d[ée]penses$/i);
  if (!al){ al = mk('Alimentation'); o.cats.unshift(al); }
  if (!au){ au = mk('Autres dépenses'); o.cats.splice(o.cats.indexOf(al) + 1, 0, au); }
  [al, au].forEach(function(c){ c.box = true; c.fixed = false; c.auto = 0; delete c.autoFrom; delete c.autoLast; });
  al.apart = true;
  o.v = 2;
}
function validState(o){
  return !!o && o.app === 'stash' && Array.isArray(o.cats) && Array.isArray(o.tx) &&
    o.cats.every(function(c){ return c && c.id && typeof c.name === 'string' && (c.type === 'dep' || c.type === 'rev' || c.type === 'ep'); }) &&
    o.tx.every(function(t){ return t && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && isFinite(t.amt); });
}
function normalize(o){
  o.cats.forEach(function(c){
    c.plan = r2(+c.plan || 0); c.fixed = !!c.fixed; c.opens = !!c.opens && c.type === 'rev'; c.auto = Math.min(31, Math.max(0, parseInt(c.auto, 10) || 0));
    c.box = !!c.box && c.type === 'dep'; if (c.box){ c.fixed = false; c.auto = 0; } c.apart = !!c.apart && c.box;
  });
  if (!(o.v >= 2)) migrate2(o);
  o.tx.forEach(function(t){ t.amt = r2(+t.amt); if (!t.id) t.id = uid(); if (t.type !== 'rev' && t.type !== 'ep') t.type = 'dep'; });
  if (!Array.isArray(o.pots)) o.pots = [];
  o.pots.forEach(function(p){ p.bal = r2(+p.bal || 0); if (!p.id) p.id = uid(); });
  if (o.anchor && !o.anchor.date && /^\d{4}-\d{2}$/.test(o.anchor.month || '')) o.anchor = { date: o.anchor.month + '-01', amount: o.anchor.amount };
  if (!o.anchor || !isFinite(o.anchor.amount) || !/^\d{4}-\d{2}-\d{2}$/.test(o.anchor.date || '')) o.anchor = null;
  return o;
}
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

if (typeof module !== 'undefined') module.exports = { r2: r2, parseAmt: parseAmt, addM: addM, balAt: balAt, periods: periods, curIndex: curIndex, dayAdd: dayAdd, dayDiff: dayDiff, stats: stats, autoRun: autoRun, defaults: defaults, validState: validState, normalize: normalize, mkey: mkey, groupOf: groupOf, moveCat: moveCat };

/* ---------- interface ---------- */
if (typeof document !== 'undefined') (function(){
  var S = load(), TODAY = iso(new Date()), PS = [], CI = 0;
  var UI = { tab: 'mois', i: -1, form: null, boxv: {}, reorder: false }, installEvt = null; // boxv : montants en cours de saisie dans les grosses cases
  function sync(tx){ // recalcule les mois ; tx : se placer sur le mois qui contient cette opération
    TODAY = iso(new Date()); PS = periods(S, TODAY); CI = curIndex(PS, TODAY);
    if (tx){ for (var k = 0; k < PS.length; k++) if (inP(tx, PS[k])) UI.i = k; }
    if (UI.i < 0 || UI.i >= PS.length) UI.i = CI;
  }
  function P(){ return PS[UI.i]; }
  var $ = function(q){ return document.querySelector(q); };
  var EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  function fmt(n){ return EUR.format(n); }
  function plain(n){ return n ? String(r2(n)).replace('.', ',') : ''; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function load(){
    try { var o = JSON.parse(localStorage.getItem(KEY)); if (validState(o)) return normalize(o); } catch (e) {}
    return defaults();
  }
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Enregistrement impossible'); } try { cloudMark(); } catch (e) {} }
  function cat(id){ for (var i = 0; i < S.cats.length; i++) if (S.cats[i].id === id) return S.cats[i]; return null; }
  function tcls(type){ return type === 'rev' ? ' rev' : type === 'ep' ? ' ep' : ''; }
  function pot(id){ for (var i = 0; i < S.pots.length; i++) if (S.pots[i].id === id) return S.pots[i]; return null; }
  function potAdd(id, d){ var p = id ? pot(id) : null; if (p) p.bal = r2(p.bal + d); }
  function simpleRow(c, st){
    var real = r2(st.by[c.id] || 0), p = c.type === 'ep' ? pot(c.pot) : null;
    return '<button class="row" data-act="add" data-cat="' + c.id + '"><div class="dot' + tcls(c.type) + '">' + esc(c.name.charAt(0).toUpperCase()) + '</div><div class="g"><div class="t">' + esc(c.name) +
      '</div>' + (c.plan || p ? '<div class="s num">' + (c.plan ? 'Prévu ' + fmt(c.plan) : '') + (c.plan && p ? ' · ' : '') + (p ? 'vers ' + esc(p.name) : '') + '</div>' : '') + '</div><div class="a num">' + fmt(real) + '</div></button>';
  }
  function cname(t){ var c = cat(t.cat); return c ? c.name : 'Catégorie supprimée'; }
  function mLabel(m, short){ return new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString('fr-FR', short ? { month: 'short' } : { month: 'long', year: 'numeric' }); }
  function dLabel(d){ return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); }
  function dShort(d){ return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }).replace(/^1 /, '1er '); }
  function defDate(){ return UI.i === CI ? TODAY : P().start; }
  function pLabel(p, short){ return mLabel((p.cal ? p.start : dayAdd(p.start, 15)).slice(0, 7), short); }
  function pSub(p){ return p.cal ? '' : (p.end ? 'du ' + dShort(p.start) + ' au ' + dShort(dayAdd(p.end, -1)) : 'depuis le ' + dShort(p.start)); }
  function toast(msg){ var t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function(){ t.classList.remove('on'); }, 2200); }
  function pct(a, b){ return b > 0 ? Math.min(100, Math.round(a / b * 100)) : (a > 0 ? 100 : 0); }
  var CH = { l: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
             r: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
             x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
             ok: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
             u: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15l7-7 7 7"/></svg>',
             d: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l7 7 7-7"/></svg>' };

  function top(){
    var p = P(), sub = pSub(p);
    return '<div class="top"><div class="month"><button class="ib" data-act="m-prev" aria-label="Mois précédent"' + (UI.i <= 0 ? ' disabled' : '') + '>' + CH.l + '</button><h1>' + esc(pLabel(p)) +
      (sub ? '<small>' + esc(sub) + '</small>' : '') + '</h1><button class="ib" data-act="m-next" aria-label="Mois suivant"' + (UI.i >= PS.length - 1 ? ' disabled' : '') + '>' + CH.r + '</button></div>' +
      (UI.i !== CI ? '<button class="pill" data-act="m-now">Aujourd’hui</button>' : '') + '</div>';
  }

  /* --- écran Mois --- */
  function vMois(){
    var st = stats(S, P()), cur = UI.i === CI, h = top() + cloudWarn();
    h += '<div class="card hero"><div class="lbl">' + (cur ? 'Solde actuel' : UI.i < CI ? 'Solde final' : 'Solde prévu') + '</div>' +
      '<div class="big num' + (st.bal < 0 ? ' neg' : '') + '">' + fmt(st.bal) + '</div><div class="trio num">' +
      '<div><span>Départ</span><b>' + fmt(st.start) + '</b></div>' +
      '<div><span>Épargné ce mois</span><b class="' + (st.saved < 0 ? 'neg' : 'pos') + '">' + (st.saved > 0 ? '+' : '') + fmt(st.saved) + '</b></div>' +
      (UI.i >= CI ? '<div><span>Fin de mois estimée</span><b class="' + (st.proj < 0 ? 'neg' : '') + '">' + fmt(st.proj) + '</b></div>'
                       : '<div><span>Écart au budget</span><b class="' + (st.pDep - st.dep < 0 ? 'neg' : 'pos') + '">' + fmt(st.pDep - st.dep) + '</b></div>') +
      '</div></div>';
    var over = st.dep > st.pDep && st.pDep > 0;
    h += '<div class="duo num"><div class="card"><div class="lbl">Dépenses</div><b>' + fmt(st.dep) + '</b><small>sur ' + fmt(st.pDep) + ' prévus</small>' +
      '<div class="bar"><i class="' + (over ? 'over' : '') + '" style="width:' + pct(st.dep, st.pDep) + '%"></i></div></div>' +
      '<div class="card"><div class="lbl">Revenus</div><b>' + fmt(st.rev) + '</b><small>sur ' + fmt(st.pRev) + ' prévus</small>' +
      '<div class="bar"><i class="rev" style="width:' + pct(st.rev, st.pRev) + '%"></i></div></div></div>';

    var bx = S.cats.filter(function(c){ return groupOf(c) === 'box'; });
    if (bx.length) h += '<div class="duo">' + bx.map(function(c){ return boxCard(c, st, cur); }).join('') + '</div>';

    var fx = S.cats.filter(function(c){ return groupOf(c) === 'fixed'; }),
        va = S.cats.filter(function(c){ return groupOf(c) === 'budget'; }),
        rv = S.cats.filter(function(c){ return c.type === 'rev'; });
    if (fx.length){
      h += '<h2>Charges fixes<small>' + (st.resteFixe > 0 ? 'reste ' + fmt(st.resteFixe) : fx.every(function(c){ return st.n[c.id]; }) ? 'tout est payé' : '') + '</small></h2><div class="list">' + fx.map(function(c){ return fixedRow(c, st); }).join('') + '</div>';
    }
    if (va.length){
      h += '<h2>Budgets</h2><div class="list">' + va.map(function(c){
        var real = r2(st.by[c.id] || 0), left = r2(c.plan - real), p = pct(real, c.plan);
        return '<button class="row" data-act="add" data-cat="' + c.id + '"><div class="g"><div style="display:flex;justify-content:space-between;gap:10px"><span class="t">' + esc(c.name) +
          '</span><span class="a num">' + fmt(real) + (c.plan ? ' <span class="s">/ ' + fmt(c.plan) + '</span>' : '') + '</span></div>' +
          (c.plan ? '<div class="bar"><i class="' + (left < 0 ? 'over' : p >= 85 ? 'warn' : '') + '" style="width:' + p + '%"></i></div><div class="s num" style="margin-top:6px">' +
            (left < 0 ? '<span class="neg">Dépassé de ' + fmt(-left) + '</span>' : 'Reste ' + fmt(left)) + '</div>' : '') + '</div></button>';
      }).join('') + '</div>';
    }
    var epc = S.cats.filter(function(c){ return c.type === 'ep'; });
    if (epc.length){
      h += '<h2>Épargne<small class="num">' + (st.ep > 0 ? fmt(st.ep) + ' placés' : '') + '</small></h2><div class="list">' + epc.map(function(c){ return c.fixed ? fixedRow(c, st) : simpleRow(c, st); }).join('') + '</div>';
    }
    if (rv.length){
      h += '<h2>Revenus</h2><div class="list">' + rv.map(function(c){ return c.fixed ? fixedRow(c, st) : simpleRow(c, st); }).join('') + '</div>';
    }
    return h;
  }
  /* Grosse case : le total du mois, et sur le mois en cours un montant à taper + Payer (dépense datée d'aujourd'hui). */
  function boxCard(c, st, cur){
    var real = r2(st.by[c.id] || 0), p = pct(real, c.plan);
    var h = '<div class="card box"><div class="lbl">' + esc(c.name) + '</div><b class="num">' + fmt(real) + '</b><small' + (c.plan ? ' class="num">sur ' + fmt(c.plan) + ' prévus' : '>ce mois-ci') + '</small>' +
      (c.plan ? '<div class="bar"><i class="' + (real > c.plan ? 'over' : p >= 85 ? 'warn' : '') + '" style="width:' + p + '%"></i></div>' : '');
    if (cur) h += '<div class="pay"><label class="amt-s"><input data-box="' + c.id + '" inputmode="decimal" enterkeyhint="done" placeholder="0,00" autocomplete="off" aria-label="Montant ' + esc(c.name) + '" value="' + esc(UI.boxv[c.id] || '') + '"><span>€</span></label>' +
      '<button class="btn" data-act="box-pay" data-cat="' + c.id + '">Payer</button></div>';
    return h + '</div>';
  }
  function boxPay(id){
    var c = cat(id), el = document.querySelector('input[data-box="' + id + '"]'), a = parseAmt(el ? el.value : '');
    if (!c) return;
    if (!(a > 0)){ toast('Tape d’abord un montant'); if (el) el.focus(); return; }
    var d = iso(new Date());
    S.tx.push({ id: uid(), date: d, amt: a, type: 'dep', cat: c.id, note: '', pot: '' });
    delete UI.boxv[id];
    if (el) el.blur();
    save(); sync({ date: d }); render();
    toast(c.name + ' : ' + fmt(a) + ' payés');
  }
  function fixedRow(c, st){
    var done = !!st.n[c.id], real = r2(st.by[c.id] || 0), rev = tcls(c.type), pp = c.type === 'ep' ? pot(c.pot) : null;
    var last = done ? txP(S, P()).filter(function(t){ return t.cat === c.id; }).sort(function(a, b){ return a.date < b.date ? 1 : -1; })[0] : null;
    return '<div class="row"><button class="dot' + rev + (done ? ' done' : '') + '" data-act="' + (done ? 'edit' : 'add') + '" data-id="' + (last ? last.id : '') + '" data-cat="' + c.id + '" aria-label="' + esc(c.name) + '">' +
      (done ? CH.ok : esc(c.name.charAt(0).toUpperCase())) + '</button>' +
      '<button class="g" style="text-align:left" data-act="' + (done ? 'edit' : 'add') + '" data-id="' + (last ? last.id : '') + '" data-cat="' + c.id + '"><div class="t">' + esc(c.name) + '</div><div class="s num">' +
      (done ? (c.type === 'rev' ? 'Reçu le ' : c.type === 'ep' ? 'Versé le ' : 'Payé le ') + dShort(last.date) : 'Prévu ' + fmt(c.plan)) + (pp ? ' · vers ' + esc(pp.name) : '') + (!done && c.auto ? ' · auto le ' + c.auto : '') + '</div></button>' +
      (done ? '<div class="a num">' + fmt(real) + '</div>' : '') +
      // le revenu qui démarre le mois garde son bouton : l'encaisser de nouveau ouvre le mois suivant
      (!done || (c.opens && UI.i === CI && dayDiff(P().start, TODAY) >= MINP)
        ? '<button class="pill' + rev + '" data-act="quick" data-cat="' + c.id + '">' + (c.type === 'rev' ? 'Encaisser' : c.type === 'ep' ? 'Verser' : 'Payer') + '</button>' : '') + '</div>';
  }

  /* --- écran Opérations --- */
  function vOps(){
    var tx = txP(S, P()).sort(function(a, b){ return a.date === b.date ? (a.id < b.id ? 1 : -1) : (a.date < b.date ? 1 : -1); }), h = top(), day = '';
    if (!tx.length) return h + '<div class="card empty">Aucune opération ce mois-ci.<br>Touche le bouton + pour en ajouter une.</div>';
    tx.forEach(function(t, i){
      if (t.date !== day){ if (day) h += '</div>'; day = t.date; h += '<div class="day">' + esc(dLabel(day)) + '</div><div class="list">'; }
      var rev = t.type === 'rev', tp = t.type === 'ep' ? pot(t.pot) : null;
      var sub = [t.note ? cname(t) : '', tp ? 'vers ' + tp.name : '', t.auto ? 'automatique' : ''].filter(Boolean).join(' · ');
      h += '<button class="row" data-act="edit" data-id="' + t.id + '"><div class="dot' + tcls(t.type) + '">' + esc(cname(t).charAt(0).toUpperCase()) + '</div><div class="g"><div class="t">' +
        esc(t.note || cname(t)) + '</div>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div><div class="a num ' + (rev ? 'pos' : t.type === 'ep' ? 'amb' : '') + '">' + (rev ? '+' : '−') + fmt(t.amt) + '</div></button>';
    });
    return h + '</div>';
  }

  /* --- écran Bilan --- */
  function vBilan(){
    var ms = [], i, max = 1, tot = 0;
    for (i = Math.max(0, CI - 5); i <= CI; i++){ var s = stats(S, PS[i]); ms.push({ i: i, p: PS[i], s: s }); max = Math.max(max, s.dep, s.rev); tot += s.saved; }
    var cur = stats(S, PS[CI]), pots = S.pots.reduce(function(a, p){ return a + p.bal; }, 0);
    var h = '<div class="top"><div class="month"><h1 style="text-align:left;min-width:0;padding-left:4px">Bilan</h1></div></div>';
    h += '<div class="card hero"><div class="lbl">Économies totales</div><div class="big num">' + fmt(cur.bal + pots) + '</div><div class="trio num" style="grid-template-columns:1fr 1fr">' +
      '<div><span>Compte courant</span><b>' + fmt(cur.bal) + '</b></div><div><span>Épargne placée</span><b>' + fmt(pots) + '</b></div></div></div>';
    h += '<div class="card"><div class="lbl">6 derniers mois</div><div class="chart">' + ms.map(function(x){
      return '<div class="c' + (x.i === CI ? ' cur' : '') + '"><div class="bars"><i class="r" style="height:' + Math.round(x.s.rev / max * 100) + '%"></i><i class="d" style="height:' + Math.round(x.s.dep / max * 100) + '%"></i></div><span>' + esc(pLabel(x.p, true)) + '</span></div>';
    }).join('') + '</div><div class="leg"><span><i style="background:var(--blue)"></i>Revenus</span><span><i style="background:var(--acc)"></i>Dépenses</span></div></div>';
    h += '<h2>Épargné par mois<small class="num">' + (tot > 0 ? '+' : '') + fmt(tot) + ' sur ' + ms.length + ' mois</small></h2><div class="list">' + ms.slice().reverse().map(function(x){
      return '<button class="row" data-act="m-go" data-i="' + x.i + '"><div class="g"><div class="t" style="text-transform:capitalize">' + esc(pLabel(x.p)) + '</div><div class="s num">' + fmt(x.s.rev) + ' reçus · ' + fmt(x.s.dep) + ' dépensés' + (x.s.ep > 0 ? ' · ' + fmt(x.s.ep) + ' placés' : '') + '</div></div><div class="a num ' + (x.s.saved < 0 ? 'neg' : 'pos') + '">' + (x.s.saved > 0 ? '+' : '') + fmt(x.s.saved) + '</div></button>';
    }).join('') + '</div>';
    S.cats.filter(function(c){ return c.apart; }).forEach(function(c){ // dépense suivie à part (Alimentation) : son total, mois par mois
      h += '<h2>' + esc(c.name) + ' par mois</h2><div class="list">' + ms.slice().reverse().map(function(x){
        return '<button class="row" data-act="m-go" data-i="' + x.i + '"><div class="g"><div class="t" style="text-transform:capitalize">' + esc(pLabel(x.p)) + '</div>' +
          (x.i === CI ? '<div class="s">en cours</div>' : '') + '</div><div class="a num">' + fmt(r2(x.s.by[c.id] || 0)) + '</div></button>';
      }).join('') + '</div>';
    });
    h += '<h2>Épargne placée</h2><div class="list">' + S.pots.map(function(p){
      return '<button class="row" data-act="pot" data-id="' + p.id + '"><div class="dot">' + esc(p.name.charAt(0).toUpperCase()) + '</div><div class="g"><div class="t">' + esc(p.name) + '</div><div class="s">Touche pour mettre à jour</div></div><div class="a num">' + fmt(p.bal) + '</div></button>';
    }).join('') + '<button class="row" data-act="pot"><div class="dot">+</div><div class="g"><div class="t">Ajouter un placement</div><div class="s">LDDS, Livret A, PEA…</div></div></button></div>';
    return h;
  }

  /* --- écran Réglages --- */
  function vRegl(){
    var ro = UI.reorder;
    var h = '<div class="top"><div class="month"><h1 style="text-align:left;min-width:0;padding-left:4px">Réglages</h1></div>' +
      '<button class="pill" data-act="reorder">' + (ro ? 'Terminé' : 'Réorganiser') + '</button></div>';
    if (ro) h += '<p class="hint">Touche les flèches pour changer l’ordre. C’est cet ordre qui s’affiche sur l’écran Mois et dans la saisie. Pour changer une catégorie de groupe, touche Terminé puis la catégorie.</p>';
    var sub = function(c){
      var g = groupOf(c);
      if (g === 'box') return c.apart ? 'Total suivi dans le Bilan' : 'Saisie rapide';
      if (g === 'budget') return 'À ne pas dépasser';
      if (g === 'fixed') return 'Chaque mois' + (c.auto ? ' · auto le ' + c.auto : '');
      return (c.fixed ? 'Fixe, chaque mois' : 'Variable') + (c.auto ? ' · auto le ' + c.auto : '') + (g === 'ep' && pot(c.pot) ? ' · vers ' + esc(pot(c.pot).name) : '');
    };
    var grp = function(g, title){
      var type = g === 'ep' || g === 'rev' ? g : 'dep', cs = S.cats.filter(function(c){ return groupOf(c) === g; });
      if (ro && !cs.length) return '';
      return '<h2>' + title + '</h2><div class="list">' + cs.map(function(c, k){
        if (ro) return '<div class="row"><div class="g"><div class="t">' + esc(c.name) + '</div><div class="s num">' + fmt(c.plan) + '</div></div>' +
          '<button class="ib" data-act="mv" data-id="' + c.id + '" data-d="-1" aria-label="Monter ' + esc(c.name) + '"' + (k ? '' : ' disabled') + '>' + CH.u + '</button>' +
          '<button class="ib" data-act="mv" data-id="' + c.id + '" data-d="1" aria-label="Descendre ' + esc(c.name) + '"' + (k < cs.length - 1 ? '' : ' disabled') + '>' + CH.d + '</button></div>';
        return '<button class="row" data-act="cat" data-id="' + c.id + '"><div class="g"><div class="t">' + esc(c.name) + '</div><div class="s">' + sub(c) + '</div></div><div class="a num">' + fmt(c.plan) + '</div></button>';
      }).join('') + (ro ? '' : '<button class="row" data-act="cat" data-type="' + type + '"' + (type === 'dep' ? ' data-disp="' + g + '"' : '') + '><div class="dot' + tcls(type) + '">+</div><div class="g"><div class="t">Ajouter une catégorie</div></div></button>') + '</div>';
    };
    h += grp('box', 'Grosses cases') + grp('fixed', 'Charges fixes') + grp('budget', 'Budgets') + grp('ep', 'Épargne prévue') + grp('rev', 'Revenus prévus');
    if (ro) return h;
    var op = opener(S);
    h += '<h2>Début du mois</h2><div class="list"><button class="row" data-act="debut"><div class="g"><div class="t">' + (op ? 'À l’encaissement : ' + esc(op.name) : 'Le 1er de chaque mois') +
      '</div><div class="s">' + (op ? 'Un nouveau mois démarre quand tu encaisses ce revenu' : 'Touche pour démarrer le mois à la paie') + '</div></div></button></div>';
    h += '<h2>Compte</h2><div class="list"><button class="row" data-act="solde"><div class="g"><div class="t">Recaler le solde</div><div class="s">Si l’appli ne correspond plus à ta banque</div></div><div class="a num">' + fmt(stats(S, PS[CI]).bal) + '</div></button></div>';
    h += '<h2>Sauvegarde en ligne</h2>' + cloudCard();
    h += '<h2>Sauvegarde fichier</h2><div class="card"><p class="hint">' + (CLOUD.url ? 'En plus de la copie en ligne, tu peux exporter un fichier.' : 'Sans sauvegarde en ligne, tes données restent uniquement sur ce téléphone. Exporte-les de temps en temps pour ne rien perdre.') + '<br>Dernier export : ' +
      (S.lastExport ? new Date(S.lastExport).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'jamais') + '</p><div class="btns"><button class="btn" data-act="export">Exporter</button><button class="btn ghost" data-act="import">Importer</button></div></div>';
    h += '<h2>Remise à zéro</h2><div class="card"><p class="hint">' + (CLOUD.url ? 'Ton Drive garde une copie par jour pendant 30 jours : tu pourras revenir en arrière.' : 'Pense à exporter avant : une remise à zéro ne peut pas être annulée.') + '</p>' +
      '<button class="btn danger" data-act="reset-tx">Effacer les opérations</button><p class="hint" style="margin-top:8px">Garde tes catégories, tes montants prévus, tes placements et ton solde actuel.</p>' +
      '<button class="btn danger" data-act="reset-all">Tout remettre à zéro</button><p class="hint" style="margin:8px 2px 0">Efface tout et revient à l’écran de départ.</p></div>';
    if (installEvt) h += '<h2>Installation</h2><div class="card"><p class="hint">Ajoute Stash sur ton écran d’accueil, comme une vraie appli.</p><button class="btn" data-act="install">Installer l’appli</button></div>';
    h += '<p class="hint" style="text-align:center;margin-top:22px">Stash · version ' + VERSION + '</p>';
    return h;
  }

  function vWelcome(){
    var f = CLOUD.found;
    return '<div class="welcome"><img class="logo" src="icon.svg" alt=""><h1>Stash</h1><p>Ton budget du mois, sans tableur.</p>' +
      (f ? '<div class="card found"><b>Sauvegarde trouvée dans ton Drive</b><p class="hint">Copie ' + esc(ofTxt(f.le)) + ' : ' + esc(nbTxt(f.nb)) + '.</p><button class="btn" data-act="c-restore-found"' + (CLOUD.busy ? ' disabled' : '') + '>' + (CLOUD.busy ? 'Récupération…' : 'Restaurer') + '</button></div>' : '') +
      '<div class="card"><label class="f" for="w-amt">Solde actuel de ton compte courant</label>' +
      '<div class="amt"><input id="w-amt" inputmode="decimal" placeholder="0,00" autocomplete="off"><span>€</span></div><div class="err" id="w-err"></div><button class="btn" data-act="start">Commencer</button></div>' +
      '<button class="btn ghost" data-act="import">J’ai un fichier de démarrage</button>' +
      (CLOUD.url ? '' : '<button class="btn ghost" style="margin-top:10px" data-act="c-open">Récupérer ma sauvegarde Drive</button>') + '</div>';
  }

  function render(){
    var w = !S.anchor; $('#nav').hidden = w;
    if (!w){ var na = autoRun(S, iso(new Date())); if (na){ save(); toast(na + (na > 1 ? ' opérations automatiques ajoutées' : ' opération automatique ajoutée')); } }
    sync();
    $('#app').innerHTML = w ? vWelcome() : UI.tab === 'ops' ? vOps() : UI.tab === 'bilan' ? vBilan() : UI.tab === 'regl' ? vRegl() : vMois();
    [].forEach.call(document.querySelectorAll('nav .tab'), function(b){ b.classList.toggle('on', b.dataset.tab === UI.tab); });
  }

  /* --- panneaux --- */
  function openSheet(){ renderSheet(); $('#sheet').classList.add('on'); $('#veil').classList.add('on'); }
  function closeSheet(){ UI.form = null; $('#sheet').classList.remove('on'); $('#veil').classList.remove('on'); if (document.activeElement) document.activeElement.blur(); }
  function head(t){ return '<div class="grip"></div><div class="sh"><h3>' + t + '</h3><button class="ib" data-act="close" aria-label="Fermer">' + CH.x + '</button></div>'; }
  function seg(f){
    return '<div class="seg">' + [['dep', 'Dépense'], ['rev', 'Revenu'], ['ep', 'Épargne']].map(function(o){
      return '<button data-act="f-type" data-v="' + o[0] + '" class="' + (f.type === o[0] ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</div>';
  }
  function renderSheet(){
    var f = UI.form, h = '';
    if (f.kind === 'tx'){
      var cs = S.cats.filter(function(c){ return c.type === f.type; });
      h = head(f.id ? 'Modifier' : 'Nouvelle opération') + seg(f) +
        '<div class="amt"><input id="f-amt" inputmode="decimal" placeholder="0,00" autocomplete="off" value="' + esc(f.amt) + '"><span>€</span></div>' +
        (cs.length ? '<div class="chips">' + cs.map(function(c){ return '<button class="chip' + (f.cat === c.id ? ' on' + tcls(f.type) : '') + '" data-act="f-cat" data-v="' + c.id + '">' + esc(c.name) + '</button>'; }).join('') + '</div>'
                   : '<p class="hint">Aucune catégorie de ce type. Crée-la d’abord dans Réglages.</p>') +
        '<div class="two"><div><label class="f" for="f-date">Date</label><input class="in" type="date" id="f-date" value="' + esc(f.date) + '"></div>' +
        '<div><label class="f" for="f-note">Note (facultatif)</label><input class="in" id="f-note" maxlength="60" autocomplete="off" value="' + esc(f.note) + '"></div></div>' +
        '<div class="err" id="f-err"></div><button class="btn" data-act="f-save">Enregistrer</button>' + (f.id ? '<button class="btn danger" style="margin-top:10px" data-act="f-del">Supprimer</button>' : '');
    } else if (f.kind === 'cat' && f.type === 'dep'){
      var dp = f.disp || 'budget';
      h = head(f.id ? 'Catégorie' : 'Nouvelle catégorie') + (f.id ? '' : seg(f)) +
        '<label class="f" for="f-name">Nom</label><input class="in" id="f-name" maxlength="30" autocomplete="off" value="' + esc(f.name) + '">' +
        '<label class="f">Sur l’écran Mois</label><div class="seg">' + [['box', 'Grosse case'], ['fixed', 'Charge fixe'], ['budget', 'Budget']].map(function(o){
          return '<button data-act="f-disp" data-v="' + o[0] + '" class="' + (dp === o[0] ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</div>' +
        '<p class="hint">' + (dp === 'box' ? 'Une grande case en haut de l’écran : tu tapes un montant, tu touches Payer.' : dp === 'fixed' ? 'Loyer, abonnement… : payé d’un geste chaque mois.' : 'Une ligne avec une barre : ce qu’il te reste à dépenser.') + '</p>' +
        '<label class="f" for="f-amt">' + (dp === 'fixed' ? 'Montant chaque mois (€)' : 'Budget du mois (€, facultatif)') + '</label><input class="in" id="f-amt" inputmode="decimal" placeholder="0,00" autocomplete="off" value="' + esc(f.amt) + '">' +
        (dp === 'box' ? '<label class="chk"><input type="checkbox" id="f-apart"' + (f.apart ? ' checked' : '') + '>Voir son total mois par mois dans le Bilan</label>' : '') +
        (dp === 'fixed' ? '<label class="f" for="f-auto">Saisie automatique : jour du mois (facultatif)</label><input class="in" id="f-auto" inputmode="numeric" maxlength="2" placeholder="Vide = à cocher à la main" autocomplete="off" value="' + esc(f.auto) + '">' +
          '<p class="hint">Pour un prélèvement programmé : l’appli enregistre l’opération toute seule ce jour-là, à ta prochaine ouverture.</p>' : '') +
        '<div class="err" id="f-err"></div><button class="btn" data-act="f-save">Enregistrer</button>' + (f.id ? '<button class="btn danger" style="margin-top:10px" data-act="f-del">Supprimer la catégorie</button>' : '');
    } else if (f.kind === 'cat'){
      h = head(f.id ? 'Catégorie' : 'Nouvelle catégorie') + (f.id ? '' : seg(f)) +
        '<label class="f" for="f-name">Nom</label><input class="in" id="f-name" maxlength="30" autocomplete="off" value="' + esc(f.name) + '">' +
        '<label class="f" for="f-amt">Montant prévu par mois (€)</label><input class="in" id="f-amt" inputmode="decimal" placeholder="0,00" autocomplete="off" value="' + esc(f.amt) + '">' +
        (f.type === 'ep' ? '<label class="f" for="f-pot">Placement qui reçoit les versements</label>' + (S.pots.length
            ? '<select class="in" id="f-pot">' + S.pots.map(function(p){ return '<option value="' + p.id + '"' + (f.pot === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>'
            : '<p class="hint">Aucun placement pour l’instant. Ajoute-le d’abord dans l’onglet Bilan (PEA, LDDS…).</p>') : '') +
        '<label class="chk"><input type="checkbox" id="f-fixed"' + (f.fixed ? ' checked' : '') + '>Montant fixe, une fois par mois</label>' +
        '<p class="hint">Fixe : loyer, abonnement, salaire — à cocher d’un geste chaque mois. Variable : un budget à ne pas dépasser.</p>' +
        '<label class="f" for="f-auto">Saisie automatique : jour du mois (facultatif)</label><input class="in" id="f-auto" inputmode="numeric" maxlength="2" placeholder="Vide = à cocher à la main" autocomplete="off" value="' + esc(f.auto) + '">' +
        '<p class="hint">Pour un virement ou un prélèvement programmé : l’appli enregistre l’opération toute seule ce jour-là, à ta prochaine ouverture.</p>' +
        '<div class="err" id="f-err"></div><button class="btn" data-act="f-save">Enregistrer</button>' + (f.id ? '<button class="btn danger" style="margin-top:10px" data-act="f-del">Supprimer la catégorie</button>' : '');
    } else if (f.kind === 'pot'){
      h = head(f.id ? 'Placement' : 'Nouveau placement') + '<label class="f" for="f-name">Nom</label><input class="in" id="f-name" maxlength="30" autocomplete="off" value="' + esc(f.name) + '">' +
        '<label class="f" for="f-amt">Valeur actuelle (€)</label><input class="in" id="f-amt" inputmode="decimal" placeholder="0,00" autocomplete="off" value="' + esc(f.amt) + '">' +
        '<div class="err" id="f-err"></div><button class="btn" data-act="f-save">Enregistrer</button>' + (f.id ? '<button class="btn danger" style="margin-top:10px" data-act="f-del">Supprimer</button>' : '');
    } else if (f.kind === 'solde'){
      h = head('Recaler le solde') + '<p class="hint">Indique le solde réel de ton compte courant aujourd’hui. Tes opérations ne sont pas modifiées.</p>' +
        '<div class="amt"><input id="f-amt" inputmode="decimal" placeholder="0,00" autocomplete="off" value="' + esc(f.amt) + '"><span>€</span></div><div class="err" id="f-err"></div><button class="btn" data-act="f-save">Enregistrer</button>';
    }
    if (f.kind === 'cloud'){
      h = head('Sauvegarde en ligne') + '<p class="hint">Colle le lien de ton script Google de sauvegarde (il finit par <b>/exec</b>). Stash récupère alors la dernière copie de ton Drive.</p>' + cloudForm();
    }
    if (f.kind === 'debut'){
      h = head('Début du mois') + '<p class="hint">Choisis ce qui démarre un nouveau mois. Avec un revenu, le mois commence le jour où tu l’encaisses, même si la date change d’un mois à l’autre.</p>' +
        '<div class="chips"><button class="chip' + (!f.cat ? ' on' : '') + '" data-act="f-cat" data-v="">Le 1er du mois</button>' + S.cats.filter(function(c){ return c.type === 'rev'; }).map(function(c){
          return '<button class="chip' + (f.cat === c.id ? ' on rev' : '') + '" data-act="f-cat" data-v="' + c.id + '">' + esc(c.name) + '</button>'; }).join('') + '</div>' +
        '<p class="hint">Deux encaissements à moins de ' + MINP + ' jours d’écart ne démarrent qu’un seul mois.</p><div class="err" id="f-err"></div><button class="btn" data-act="f-save">Enregistrer</button>';
    }
    $('#sheet').innerHTML = h;
  }
  function grab(){ // garde ce qui est tapé avant de redessiner le panneau
    var f = UI.form, g = function(id){ var e = $('#' + id); return e ? e.value : undefined; };
    if (!f) return;
    ['amt', 'date', 'note', 'name', 'auto'].forEach(function(k){ var v = g('f-' + k); if (v !== undefined) f[k] = v; });
    var fx = $('#f-fixed'); if (fx) f.fixed = fx.checked;
    var fa = $('#f-apart'); if (fa) f.apart = fa.checked;
    var fp = $('#f-pot'); if (fp) f.pot = fp.value;
  }
  function fail(msg){ var e = $('#f-err'); if (e) e.textContent = msg; }

  function saveForm(){
    if (UI.form && UI.form.kind === 'cloud') return cloudConnect();
    grab(); var f = UI.form, a = parseAmt(f.amt);
    if (f.kind === 'tx'){
      if (!(a > 0)) return fail('Indique un montant supérieur à 0.');
      if (!f.cat || !cat(f.cat) || cat(f.cat).type !== f.type) return fail('Choisis une catégorie.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return fail('Choisis une date.');
      var t = f.id ? S.tx.filter(function(x){ return x.id === f.id; })[0] : null;
      if (!t){ t = { id: uid() }; S.tx.push(t); }
      else if (t.type === 'ep') potAdd(t.pot, -t.amt);
      t.date = f.date; t.amt = a; t.type = f.type; t.cat = f.cat; t.note = (f.note || '').trim();
      t.pot = f.type === 'ep' ? (cat(f.cat).pot || '') : '';
      if (t.type === 'ep') potAdd(t.pot, a);
      var n0 = PS.length; sync({ date: f.date });
      toast(PS.length > n0 && opener(S) ? 'Nouveau mois démarré' : f.id ? 'Opération modifiée' : 'Opération ajoutée');
    } else if (f.kind === 'cat'){
      var name = (f.name || '').trim();
      if (!name) return fail('Donne un nom à la catégorie.');
      if (f.amt !== '' && !(a >= 0)) return fail('Montant prévu invalide.');
      if (f.type === 'ep' && !pot(f.pot)) return fail('Choisis le placement qui reçoit les versements.');
      var dp = f.type === 'dep' ? (f.disp || 'budget') : '';
      var as = dp && dp !== 'fixed' ? '' : String(f.auto == null ? '' : f.auto).trim(), au = as === '' ? 0 : (/^\d{1,2}$/.test(as) ? +as : -1);
      if (au < 0 || au > 31) return fail('Jour de saisie automatique : un nombre entre 1 et 31.');
      if (au && !(a > 0)) return fail('La saisie automatique demande un montant prévu.');
      var c = f.id ? cat(f.id) : null;
      if (au && c && c.opens) return fail('Ce revenu démarre le mois : il s’encaisse à la main.');
      if (!c){ c = { id: uid() }; S.cats.push(c); }
      c.name = name; c.type = f.type; c.plan = a >= 0 ? a : 0; c.fixed = dp ? dp === 'fixed' : (!!f.fixed || !!au);
      c.box = dp === 'box'; c.apart = c.box && !!f.apart;
      if (f.type === 'ep') c.pot = f.pot;
      if ((c.auto || 0) !== au){ c.auto = au; c.autoFrom = TODAY; delete c.autoLast; } // nouveau jour : on repart d'aujourd'hui, sans rattrapage du passé
    } else if (f.kind === 'pot'){
      var pn = (f.name || '').trim();
      if (!pn) return fail('Donne un nom au placement.');
      if (!(a >= 0)) return fail('Indique la valeur du placement.');
      var p = f.id ? S.pots.filter(function(x){ return x.id === f.id; })[0] : null;
      if (!p){ p = { id: uid() }; S.pots.push(p); }
      p.name = pn; p.bal = a;
    } else if (f.kind === 'solde'){
      if (isNaN(a)) return fail('Indique un montant.');
      // recalage : on décale le solde de référence pour que le solde du mois en cours soit exactement celui saisi
      S.anchor.amount = r2(S.anchor.amount + (a - stats(S, PS[CI]).bal));
      toast('Solde recalé');
    } else if (f.kind === 'debut'){
      S.cats.forEach(function(c){ c.opens = c.type === 'rev' && c.id === f.cat; if (c.opens) c.auto = 0; }); UI.i = -1;
    }
    save(); closeSheet(); render();
  }
  function delForm(){
    var f = UI.form;
    if (f.kind === 'tx'){ S.tx.forEach(function(x){ if (x.id === f.id && x.type === 'ep') potAdd(x.pot, -x.amt); }); S.tx = S.tx.filter(function(x){ return x.id !== f.id; }); }
    else if (f.kind === 'pot') S.pots = S.pots.filter(function(x){ return x.id !== f.id; });
    else if (f.kind === 'cat'){
      var n = S.tx.filter(function(x){ return x.cat === f.id; }).length;
      if (n && !confirm('Cette catégorie a ' + n + ' opération' + (n > 1 ? 's' : '') + '. Elles seront conservées dans tes totaux. Supprimer la catégorie ?')) return;
      S.cats = S.cats.filter(function(x){ return x.id !== f.id; });
    }
    save(); closeSheet(); render(); toast('Supprimé');
  }

  function doExport(){
    S.lastExport = Date.now(); save();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' }));
    a.download = 'stash-' + iso(new Date()) + '.json'; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500); render();
  }
  function doImport(file){
    var r = new FileReader();
    r.onload = function(){
      var o; try { o = JSON.parse(r.result); } catch (e) { o = null; }
      if (!validState(o)) return toast('Ce fichier n’est pas un fichier Stash');
      if (S.tx.length && !confirm('Remplacer toutes les données actuelles par celles du fichier (' + o.tx.length + ' opération' + (o.tx.length > 1 ? 's' : '') + ') ?')) return;
      S = normalize(o); save(); UI.tab = 'mois'; UI.i = -1; render();
      toast(S.anchor ? 'Données importées' : 'Catégories importées');
    };
    r.readAsText(file);
  }

  /* --- sauvegarde en ligne : le script Google de l'utilisateur range une copie dans son Drive.
     Réglage gardé à part des données (clé « stash-cloud »), pour survivre à un import ou une remise à zéro.
     Une appli vide (jamais commencée) n'envoie jamais rien. --- */
  var CK = 'stash-cloud';
  var CLOUD = { url: '', last: null, lastErr: null, errSince: null, dirty: false, busy: false, again: false, t: null, found: null, choice: null, draft: '', msg: '' };
  function cloudLoad(){ try { var o = JSON.parse(localStorage.getItem(CK) || '{}') || {}; CLOUD.url = o.url || ''; CLOUD.last = o.last || null; CLOUD.lastErr = o.lastErr || null; CLOUD.errSince = o.errSince || null; CLOUD.dirty = !!o.dirty; } catch (e) {} }
  function cloudSave(){ try { localStorage.setItem(CK, JSON.stringify({ url: CLOUD.url, last: CLOUD.last, lastErr: CLOUD.lastErr, errSince: CLOUD.errSince, dirty: CLOUD.dirty })); } catch (e) {} }
  function cloudUrlOk(v){ return /^https:\/\/script\.google\.com\/[^\s]+\/exec$/.test(String(v || '').trim()); }
  function countOf(s){ var n = function(k){ return s && Array.isArray(s[k]) ? s[k].length : 0; }; return { o: n('tx'), p: n('pots'), c: n('cats'), a: !!(s && s.anchor) }; }
  function isEmptyNb(nb){ return !nb || (!nb.o && !nb.p && !nb.a); }
  function nbTxt(nb){
    var p = [];
    if (nb.o) p.push(nb.o + ' opération' + (nb.o > 1 ? 's' : ''));
    if (nb.p) p.push(nb.p + ' placement' + (nb.p > 1 ? 's' : ''));
    return p.length ? p.join(', ') : 'solde de départ seulement';
  }
  function whenTxt(v){
    var d = new Date(v), j = iso(d), hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    var t = iso(new Date()), y = dayAdd(t, -1);
    return (j === t ? 'aujourd’hui' : j === y ? 'hier' : dLabel(j)) + ' à ' + hm;
  }
  function ofTxt(v){ var w = whenTxt(v); return /^(aujourd|hier)/.test(w) ? 'd’' + w : 'du ' + w; } // « copie d’hier à… », « copie du samedi… »
  function cloudErrMsg(e){
    if (e && e.stash) return e.stash;
    if (!navigator.onLine) return 'Pas de connexion : nouvel essai plus tard.';
    return 'Le lien ne répond pas. Vérifie le déploiement du script (« Qui a accès : Tout le monde »).';
  }
  async function cloudReq(url, body){
    var opt = body ? { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', cache: 'no-store' } : { redirect: 'follow', cache: 'no-store' };
    var r = await fetch(url, opt), j;
    if (!r.ok) throw { stash: 'Le script Google a répondu par une erreur (' + r.status + ').' };
    try { j = await r.json(); } catch (e) { throw { stash: 'Le lien ne renvoie pas une sauvegarde Stash. Vérifie « Qui a accès : Tout le monde ».' }; }
    if (!j || j.ok !== true) throw { stash: (j && j.erreur) || 'Réponse inattendue du script.' };
    return j;
  }
  function cloudGet(url, action){ return cloudReq(url + (url.indexOf('?') < 0 ? '?' : '&') + 'action=' + action); }
  function cloudRefresh(){
    if (UI.form && UI.form.kind === 'cloud') renderSheet();
    else if (!UI.form && !(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.box)) render();
  }
  function cloudMark(){
    if (!CLOUD.url) return;
    CLOUD.dirty = true; cloudSave();
    clearTimeout(CLOUD.t); CLOUD.t = setTimeout(function(){ cloudPush(false); }, 4000);
  }
  async function cloudPush(manual){
    if (!CLOUD.url) return false;
    if (CLOUD.busy){ CLOUD.again = true; return false; }
    clearTimeout(CLOUD.t);
    if (isEmptyNb(countOf(S))){ CLOUD.dirty = false; cloudSave(); if (manual) toast('Rien à sauvegarder : l’appli est vide'); return false; }
    CLOUD.busy = true; cloudRefresh();
    var ok = false;
    try {
      await cloudReq(CLOUD.url, { action: 'save', sauvegarde: S });
      CLOUD.last = new Date().toISOString(); CLOUD.lastErr = null; CLOUD.errSince = null; CLOUD.dirty = false; ok = true;
      if (manual) toast('Copie envoyée dans ton Drive');
    } catch (e){
      CLOUD.lastErr = cloudErrMsg(e); if (!CLOUD.errSince) CLOUD.errSince = new Date().toISOString();
      if (manual) toast('Envoi impossible');
    } finally { CLOUD.busy = false; cloudSave(); cloudRefresh(); }
    if (CLOUD.again){ CLOUD.again = false; cloudMark(); }
    return ok;
  }
  async function cloudConnect(){
    var el = $('#c-url'), v = (el ? el.value : CLOUD.draft).trim();
    CLOUD.draft = v; CLOUD.msg = '';
    if (!cloudUrlOk(v)){ CLOUD.msg = 'Lien non reconnu : copie l’adresse complète, qui finit par /exec.'; return cloudRefresh(); }
    CLOUD.busy = true; CLOUD.choice = null; cloudRefresh();
    try {
      var res = await cloudGet(v, 'ping');
      if (res.app !== 'stash-sauvegarde') throw { stash: 'Ce lien n’est pas le script de sauvegarde de Stash.' };
      CLOUD.busy = false;
      var dr = res.derniere && !isEmptyNb(res.derniere.nb) ? res.derniere : null;
      if (dr && !isEmptyNb(countOf(S))){ // les deux ont des données : rien n'est branché tant que tu n'as pas choisi
        CLOUD.choice = { url: v, le: dr.le, nb: dr.nb }; return cloudRefresh();
      }
      CLOUD.choice = { url: v }; cloudAdopt();
      if (isEmptyNb(countOf(S))){
        if (dr){ await cloudRestore(true); }
        else { if (UI.form && UI.form.kind === 'cloud') closeSheet(); render(); toast('Connecté à ton Drive'); }
      } else {
        render(); toast('Connecté à ton Drive'); await cloudPush(false);
      }
    } catch (e){ CLOUD.busy = false; CLOUD.msg = cloudErrMsg(e); cloudRefresh(); }
  }
  function cloudAdopt(){ // branche le lien en attente
    CLOUD.url = CLOUD.choice.url; CLOUD.choice = null; CLOUD.draft = ''; CLOUD.lastErr = null; CLOUD.errSince = null; cloudSave();
  }
  async function cloudKeepDrive(){
    var c = CLOUD.choice; cloudAdopt();
    if (!(await cloudRestore(true))){ CLOUD.url = ''; CLOUD.choice = c; cloudSave(); cloudRefresh(); } // échec : on ne laisse pas le téléphone écraser le Drive
  }
  async function cloudRestore(force){
    if (!CLOUD.url) return false;
    CLOUD.busy = true; cloudRefresh();
    try {
      var res = await cloudGet(CLOUD.url, 'load'), o = res.sauvegarde;
      if (!o || !validState(o)){ toast('Aucune copie dans ton Drive'); return false; }
      if (!force && !isEmptyNb(countOf(S)) && !confirm('Remplacer les données de ce téléphone par la copie de ton Drive (' + nbTxt(countOf(o)) + ') ?')) return false;
      S = normalize(o);
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
      clearTimeout(CLOUD.t); CLOUD.dirty = false; CLOUD.last = res.le || new Date().toISOString(); CLOUD.lastErr = null; CLOUD.errSince = null; cloudSave();
      CLOUD.found = null; CLOUD.busy = false;
      if (UI.form) closeSheet();
      UI.tab = 'mois'; UI.i = -1; render(); window.scrollTo(0, 0); toast('Données restaurées');
      return true;
    } catch (e){ CLOUD.msg = cloudErrMsg(e); toast('Récupération impossible'); return false; }
    finally { CLOUD.busy = false; cloudRefresh(); }
  }
  function cloudOff(){
    clearTimeout(CLOUD.t);
    CLOUD.url = ''; CLOUD.last = null; CLOUD.lastErr = null; CLOUD.errSince = null; CLOUD.dirty = false; CLOUD.choice = null; CLOUD.found = null; CLOUD.msg = '';
    cloudSave(); render(); toast('Sauvegarde en ligne déconnectée');
  }
  function cloudStartup(){
    if (!CLOUD.url) return;
    if (isEmptyNb(countOf(S))){
      cloudGet(CLOUD.url, 'ping').then(function(res){ if (res.derniere && !isEmptyNb(res.derniere.nb)){ CLOUD.found = res.derniere; cloudRefresh(); } }).catch(function(){});
      return;
    }
    if (CLOUD.dirty || !CLOUD.last || Date.now() - new Date(CLOUD.last).getTime() > 24 * 36e5) cloudPush(false);
  }
  function cloudForm(){
    var dis = CLOUD.busy ? ' disabled' : '', c = CLOUD.choice;
    if (c && c.nb) return '<div class="choice"><p class="hint">Ton Drive contient déjà une copie <b>' + esc(ofTxt(c.le)) + '</b> (' + esc(nbTxt(c.nb)) + '), et ce téléphone a aussi des données. Laquelle garder ?</p><div class="btns"><button class="btn ghost" data-act="c-keep-drive"' + dis + '>Celle du Drive</button><button class="btn" data-act="c-keep-phone"' + dis + '>Ce téléphone</button></div></div>' +
      '<div class="err">' + esc(CLOUD.msg) + '</div><button class="lnk" data-act="c-choice-cancel">Annuler</button>';
    return '<label class="f" for="c-url">Lien du script de sauvegarde</label><input class="in" id="c-url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(CLOUD.draft) + '"' + dis + '>' +
      '<div class="err">' + esc(CLOUD.msg) + '</div><button class="btn" data-act="c-connect"' + dis + '>' + (CLOUD.busy ? 'Connexion…' : 'Connecter') + '</button>';
  }
  function cloudCard(){
    var dis = CLOUD.busy ? ' disabled' : '';
    if (!CLOUD.url) return '<div class="card">' + (CLOUD.choice && CLOUD.choice.nb ? '' : '<p class="hint">Stash peut envoyer une copie de tes données dans ton <b>Google Drive</b> après chaque changement. Colle ici le lien de ton script Google de sauvegarde (il finit par <b>/exec</b>).</p>') + cloudForm() + '</div>';
    var st = CLOUD.busy ? '<p class="cst busy">Envoi en cours…</p>' : CLOUD.lastErr ? '<p class="cst warn">' + esc(CLOUD.lastErr) + '</p>' :
      CLOUD.last ? '<p class="cst">Dernière copie dans ton Drive : ' + esc(whenTxt(CLOUD.last)) + '</p>' : '<p class="cst busy">' + (isEmptyNb(countOf(S)) ? 'Pas encore de copie : la première partira dès que tu auras commencé.' : 'Pas encore de copie : envoi dans quelques secondes.') + '</p>';
    var h = '<div class="card"><p class="hint">Connectée à ton Google Drive (dossier « Stash – sauvegardes »). Une copie part après chaque changement ; une appli vide n’envoie jamais rien.</p>' + st;
    return h + '<div class="btns"><button class="btn" data-act="c-push"' + dis + '>Sauvegarder</button><button class="btn ghost" data-act="c-restore"' + dis + '>Restaurer</button></div>' +
      '<button class="lnk" data-act="c-off">Déconnecter</button></div>';
  }
  function cloudWarn(){ // l'envoi échoue depuis plus de 2 jours : on le signale sur l'écran du mois
    if (!CLOUD.url || !CLOUD.lastErr || !CLOUD.errSince || Date.now() - new Date(CLOUD.errSince).getTime() < 2 * 864e5) return '';
    return '<div class="card found warn"><b>La sauvegarde en ligne ne passe plus</b><p class="hint">Depuis le ' + esc(dShort(iso(new Date(CLOUD.errSince)))) + ' : ' + esc(CLOUD.lastErr) + '</p><button class="btn ghost" data-act="c-push"' + (CLOUD.busy ? ' disabled' : '') + '>Réessayer</button></div>';
  }

  /* --- événements --- */
  document.addEventListener('click', function(ev){
    var b = ev.target.closest('[data-act],[data-tab]'); if (!b) return;
    var d = b.dataset, act = d.act;
    if (d.tab){ UI.tab = d.tab; UI.reorder = false; render(); window.scrollTo(0, 0); return; }
    if (act === 'm-prev'){ if (UI.i > 0) UI.i--; render(); }
    else if (act === 'm-next'){ if (UI.i < PS.length - 1) UI.i++; render(); }
    else if (act === 'm-now'){ UI.i = CI; render(); }
    else if (act === 'm-go'){ UI.i = +d.i; UI.tab = 'mois'; render(); window.scrollTo(0, 0); }
    else if (act === 'add'){
      var c = d.cat ? cat(d.cat) : null;
      UI.form = { kind: 'tx', type: c ? c.type : 'dep', cat: c ? c.id : '', amt: c && c.fixed ? plain(c.plan) : '', date: defDate(), note: '' };
      openSheet(); if (!UI.form.amt) setTimeout(function(){ var i = $('#f-amt'); if (i) i.focus(); }, 260);
    }
    else if (act === 'edit'){
      var t = S.tx.filter(function(x){ return x.id === d.id; })[0]; if (!t) return;
      UI.form = { kind: 'tx', id: t.id, type: t.type, cat: t.cat, amt: plain(t.amt), date: t.date, note: t.note || '' }; openSheet();
    }
    else if (act === 'quick'){
      var q = cat(d.cat); if (!q) return;
      if (!(q.plan > 0)){ UI.form = { kind: 'tx', type: q.type, cat: q.id, amt: '', date: defDate(), note: '' }; return openSheet(); }
      var qd = defDate(), n0 = PS.length;
      S.tx.push({ id: uid(), date: qd, amt: q.plan, type: q.type, cat: q.id, note: '', pot: q.type === 'ep' ? (q.pot || '') : '' });
      if (q.type === 'ep') potAdd(q.pot, q.plan);
      save(); sync({ date: qd }); render();
      toast(PS.length > n0 && q.opens ? 'Nouveau mois démarré' : q.name + (q.type === 'rev' ? ' : reçu' : q.type === 'ep' ? ' : versé' : ' : payé'));
    }
    else if (act === 'cat'){
      var k = d.id ? cat(d.id) : null;
      UI.form = k ? { kind: 'cat', id: k.id, type: k.type, name: k.name, amt: plain(k.plan), fixed: k.fixed, pot: k.pot || '', auto: k.auto ? String(k.auto) : '', disp: k.type === 'dep' ? groupOf(k) : '', apart: !!k.apart }
                  : { kind: 'cat', type: d.type || 'dep', name: '', amt: '', fixed: d.type === 'ep', pot: S.pots[0] ? S.pots[0].id : '', auto: '', disp: d.disp || 'budget', apart: false };
      openSheet();
    }
    else if (act === 'pot'){
      var p = d.id ? S.pots.filter(function(x){ return x.id === d.id; })[0] : null;
      UI.form = p ? { kind: 'pot', id: p.id, name: p.name, amt: plain(p.bal) || '0' } : { kind: 'pot', name: '', amt: '' }; openSheet();
    }
    else if (act === 'solde'){ UI.form = { kind: 'solde', amt: '' }; openSheet(); }
    else if (act === 'debut'){ var o = opener(S); UI.form = { kind: 'debut', cat: o ? o.id : '' }; openSheet(); }
    else if (act === 'f-type'){ grab(); if (UI.form.type !== d.v){ UI.form.type = d.v; if (UI.form.kind === 'tx') UI.form.cat = ''; else if (d.v === 'ep' && !pot(UI.form.pot)) UI.form.pot = S.pots[0] ? S.pots[0].id : ''; } renderSheet(); }
    else if (act === 'f-cat'){ grab(); UI.form.cat = d.v; renderSheet(); }
    else if (act === 'f-disp'){ grab(); UI.form.disp = d.v; renderSheet(); }
    else if (act === 'reorder'){ UI.reorder = !UI.reorder; render(); window.scrollTo(0, 0); }
    else if (act === 'mv'){ if (moveCat(S, d.id, +d.d)){ save(); render(); } }
    else if (act === 'box-pay') boxPay(d.cat);
    else if (act === 'f-save') saveForm();
    else if (act === 'f-del') delForm();
    else if (act === 'close') closeSheet();
    else if (act === 'export') doExport();
    else if (act === 'import'){ $('#file').value = ''; $('#file').click(); }
    else if (act === 'reset-tx'){
      var nt = S.tx.length;
      if (!confirm('Effacer ' + (nt > 1 ? 'les ' + nt + ' opérations' : nt ? 'l’opération' : 'les opérations') + ' ? Tes catégories, montants prévus, placements et ton solde actuel sont conservés.')) return;
      var keep = stats(S, PS[CI]).bal; // le solde affiché aujourd'hui devient le nouveau point de départ
      S.tx = []; S.anchor = { date: TODAY, amount: keep };
      S.cats.forEach(function(c){ delete c.autoLast; if (c.auto) c.autoFrom = TODAY; });
      UI.i = -1; UI.tab = 'mois'; save(); render(); window.scrollTo(0, 0); toast('Opérations effacées');
    }
    else if (act === 'reset-all'){
      if (!confirm('Tout effacer : opérations, catégories, montants prévus et placements ? L’appli repart de l’écran de départ.')) return;
      S = defaults(); UI.i = -1; UI.tab = 'mois'; save(); render(); window.scrollTo(0, 0); toast('Appli remise à zéro');
      cloudStartup(); // si le Drive a une copie, l'écran de départ propose de la restaurer
    }
    else if (act === 'c-open'){ CLOUD.msg = ''; UI.form = { kind: 'cloud' }; openSheet(); setTimeout(function(){ var i = $('#c-url'); if (i) i.focus(); }, 260); }
    else if (act === 'c-connect') cloudConnect();
    else if (act === 'c-push') cloudPush(true);
    else if (act === 'c-restore') cloudRestore(false);
    else if (act === 'c-restore-found') cloudRestore(true);
    else if (act === 'c-keep-drive') cloudKeepDrive();
    else if (act === 'c-keep-phone'){ cloudAdopt(); cloudPush(true); }
    else if (act === 'c-choice-cancel'){ CLOUD.choice = null; CLOUD.msg = ''; cloudRefresh(); }
    else if (act === 'c-off') cloudOff();
    else if (act === 'install'){ if (installEvt){ installEvt.prompt(); installEvt = null; render(); } }
    else if (act === 'start'){
      var a = parseAmt($('#w-amt').value);
      if (isNaN(a)){ $('#w-err').textContent = 'Indique ton solde, par exemple 943,92.'; return; }
      if (CLOUD.found && !confirm('Ton Drive contient une copie (' + nbTxt(CLOUD.found.nb) + '). Repartir de zéro quand même ? Elle sera remplacée par tes nouvelles données.')) return;
      CLOUD.found = null; S.anchor = { date: TODAY, amount: a }; save(); render();
    }
  });
  $('#veil').addEventListener('click', closeSheet);
  $('#file').addEventListener('change', function(){ if (this.files[0]) doImport(this.files[0]); });
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    if (UI.form){ e.preventDefault(); saveForm(); }
    else if (e.target.id === 'c-url'){ e.preventDefault(); cloudConnect(); }
    else if (e.target.dataset.box){ e.preventDefault(); boxPay(e.target.dataset.box); }
  });
  document.addEventListener('input', function(e){ var id = e.target.dataset && e.target.dataset.box; if (id) UI.boxv[id] = e.target.value; });
  document.addEventListener('visibilitychange', function(){ if (!document.hidden && !UI.form) render(); });
  window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); installEvt = e; if (UI.tab === 'regl') render(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function(){});
  cloudLoad();
  render();
  setTimeout(cloudStartup, 400);
})();
